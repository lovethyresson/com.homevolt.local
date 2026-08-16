# Analytics

Anonymous product analytics, **off unless you turn them on**. This document is the full account of
what the app sends, when, and why — if something is not listed here, it is not sent.

All of it lives in one file, [lib/analytics.js](../lib/analytics.js). That is deliberate: it is one
file to read when asking "what does this app send?", and one file to delete if the answer should
become "nothing". Every call site elsewhere is a single `track(...)` line.

## Why any of this

The battery's console API is [unsanctioned and reverse-engineered](../CLAUDE.md); firmware varies
between units and the author has exactly one battery to test against. The questions that actually
change what gets built are things like: does mDNS discovery find the battery, or does everyone end
up typing an IP by hand? Which Flow cards do people use? Which `op_state_str` values exist in the
field that this app does not handle? None of those are answerable from a bug tracker, because the
people affected mostly do not file bugs — they just uninstall.

## Consent

Opt-in, default off. Two places set the same stored answer:

- the checkbox on the **pairing screen**, unticked by default;
- **Settings → Privacy** in the app settings page.

Both write the `analytics_consent` app setting, and `app.js` watches Homey's settings `set` event,
so a change takes effect on the next event rather than at the next app start.

Without consent, the SDK is never initialised, no anonymous id is minted, and nothing goes on the
wire. Withdrawing consent closes the local gate *and* calls `setOptOut(true)`, so an event already
queued inside Amplitude's batcher is dropped rather than flushed after you said no.

## Where the data goes

Amplitude, **EU region** (`api.eu.amplitude.com`). The region is set explicitly in
`lib/analytics.js`; the SDK's own default is US, which would both reject the EU ingestion key and
ship EU battery owners' data to a third country.

The Amplitude project is **shared with [com.nibe.local](https://github.com/) and any future Homey
app by the same author.** Every event and every user property carries an `app` property naming
which app sent it, taken from the app manifest id. This is why one project can serve several apps:
Amplitude charts cannot span projects, so a project per app would permanently foreclose questions
like "which of these apps is least reliable?".

Sharing a project does **not** link your installs to each other — see the next section.

## The only identifier

A random UUID (`crypto.randomUUID()`), minted on first use *after* consent and stored in the app
settings as `analytics_device_id`. It is not the battery IP, not a serial number, not the wifi
SSID, and not derived from anything about you or your hardware. It exists because Amplitude
requires an id per event, not because we want to know who anyone is.

Homey scopes app settings per app, so a Homey running both this app and the Nibe app mints **two
unrelated UUIDs** and counts as two Amplitude users. That is intentional: comparing apps in
aggregate does not need household-level linking, and a shared identifier would make the two
installs linkable — exactly what "random, not a serial" promises it is not.

No `user_id` is ever set.

## What is never sent

| Not sent | Why it matters |
|---|---|
| Battery readings — power, SoC, temperature, grid frequency, energy counters | The entire point of the poll loop, and none of Amplitude's business |
| Setpoint values in watts | A detail of someone's tariff optimisation; says more about their house than about this app |
| Raw `cmd` strings sent to the console | They embed setpoints *and* wall-clock timestamps. Events carry the card id, never the assembled command |
| Battery IP address, wifi SSID, wifi IP, subnet | `initSettings()` reads the SSID and IP for the device settings page; neither leaves the LAN |
| Battery serial number, hostname, discovery results | The mDNS hostname encodes the serial |
| Device names, zone names, Flow names | User-chosen and often personal |

**One caveat, stated plainly:** Amplitude sees the household's public IP as the origin of the
request and may derive coarse geography from it. That is Amplitude's behaviour, not something this
app sends. The Node SDK accepts an `ip` override per event at the `track()` choke point if that
should ever be suppressed.

## Events

| Event | When | Properties |
|---|---|---|
| `Started App` | Once per app launch, right after analytics init | `app_version` |
| `Ran THEN Card` | A Flow action card ran | `card`, `ok` |
| `Checked AND Card` | A Flow condition card was evaluated | `card`, `ok`, `result` |
| `Changed Capability` | A capability was written from outside the app | `capability`, plus `mode` / `direction` / `applied` |
| `Changed Device Set` | A device was added or removed | `action`, `driver` |
| `Completed Detection` | A pairing or repair attempt finished | `mode`, `method`, `found`, `found_nothing` |
| `Lost Connection` | The battery became unreachable | `cause`, `reason` |
| `Restored Connection` | It became reachable again | — |
| `Raised Alarm` | The battery entered an unrecognised operating state | `code` |

Every event additionally carries `app`, merged in at the single `track()` choke point.

### Per-event notes

- **`Ran THEN Card` / `Checked AND Card`** are emitted by the `trackedRunListener()` wrapper, applied
  once at the single block in `device.js` where all twelve Flow cards are registered. `card` is the
  card id (`grid_charge_now`, `charge_battery`, …); `ok` says whether it threw. Card *arguments* —
  including power values and time windows — are never included.

  There is no `Fired WHEN Card` event for this app. Its only trigger card,
  `battery_status_changed`, is never fired by app code at all — Homey automatically runs a Flow
  trigger card whose id is `<capability_id>_changed` when `setCapabilityValue()` is called for a
  custom capability, and `battery_status` is a custom string capability. So there is no run
  listener to wrap. Reporting from the capability write instead would count *state transitions*,
  which the poll loop produces whether or not a single Flow subscribes to them — a different
  question from "did a Flow run", and one already answered by `Raised Alarm`.

- **`Changed Capability`** only fires when something outside the app writes a capability — the device
  tile, the mobile app, a Flow, or the web API. The poll loop updates values without triggering it,
  so every occurrence is genuinely a hand on a control. For `target_power`, only the *direction*
  (`charge` / `discharge` / `idle`) is reported, never the watt value, and `applied: false` records a
  setpoint rejected because the battery was under partner-cloud control.

- **`Completed Detection`** is the highest-value event here. `method` distinguishes `mdns` from
  `manual`, and `found_nothing` is the only signal that discovery silently failed on a network the
  author cannot test against. Somebody typing an IP by hand *is* the finding.

- **`Lost Connection` / `Restored Connection`** are **edge-triggered** — they fire on the transition
  only. Polling runs every 5 seconds by default, so a battery that is off for an hour would
  otherwise produce ~720 identical events, drowning the project's quota and making one outage look
  like an epidemic.

- **`Raised Alarm`** fires when `op_state_str` becomes something other than `charging`,
  `discharging` or `idle` — the three values seen on real units.
  [docs/console-help.md](console-help.md) does not enumerate the rest, so the unrecognised states
  are precisely the ones worth learning about: each is either a fault or a state this app should be
  handling. The raw state string is sent as `code`. Also edge-triggered.

## User properties

Sent as an Amplitude `Identify` from `reportInstallProfile()`, debounced by 5 seconds so several
devices initialising at once collapse into one call. These describe what the install *is*, rather
than what it did, because the useful questions are cross-sectional ("of the 3-pack installs, how
many run in partner mode?") — a segmentation, not an event count.

| Property | Source |
|---|---|
| `app`, `app_version` | App manifest |
| `battery_packs` | Count of `bms_info` entries across all EMS entries |
| `rated_capacity_kwh` | Summed `bms_info.rated_cap` |
| `rated_power_w` | Summed `ems_info.rated_power` |
| `control_mode` | `target_power_mode` — `homey` or `partner` |
| `homey_version`, `homey_platform`, `homey_platform_version` | Homey SDK, reported raw rather than mapped to a product name, since that mapping is Athom's to change |
| `timezone` | The country signal — `Europe/Stockholm` resolves to a country without embedding an IANA→ISO table that goes stale |
| `language`, `units` | Locale, not location: plenty of Swedish users run Homey in English |

## Turning it off

Settings → Privacy → untick. Tracking stops on the next event. To also discard the anonymous id,
remove the app; app settings go with it.

## Where the code lives

| File | Role |
|---|---|
| [lib/analytics.js](../lib/analytics.js) | The whole surface: consent gate, id minting, `track()`, `reportInstallProfile()`, `trackedRunListener()` |
| [app.js](../app.js) | `initAnalytics()`, `Started App`, the consent settings listener, `hostFacts()` |
| [drivers/homevolt-battery/device.js](../drivers/homevolt-battery/device.js) | Flow card wrapping, capability events, connection/op-state reporting, install profile |
| [drivers/homevolt-battery/driver.js](../drivers/homevolt-battery/driver.js) | `Completed Detection`, pairing consent handlers |
| [settings/index.html](../settings/index.html) | The Privacy toggle |
| [drivers/homevolt-battery/pair/list_devices.html](../drivers/homevolt-battery/pair/list_devices.html) | The pairing consent checkbox |

## Sharp edges

- **The ingestion key and the server zone must move together.** The key is scoped to its project's
  region; an EU key against the US endpoint is rejected outright.
- **The key is shared with the other Homey apps by design.** Do not mint a per-app key — that would
  split the data into projects Amplitude cannot chart across, which is the exact outcome the `app`
  property exists to avoid.
- **Adding an event or property means updating this file.** It is the only record of what leaves the
  device, so it is only true if it is maintained.
- **Nothing calls `flush()` on shutdown**, so up to ~10 seconds of events can be lost on an app
  restart. Acceptable: this is product analytics, not billing.
