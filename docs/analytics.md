# Analytics

Anonymous product analytics, **off unless you turn them on**. This document is the full account of
what the app sends, when, and why — if something is not listed here, it is not sent.

All of it lives in one file, [lib/analytics.js](../lib/analytics.js). That is deliberate: it is one
file to read when asking "what does this app send?", and one file to delete if the answer should
become "nothing". Every call site elsewhere is a single `track(...)` line.

**Names and types are governed by [docs/analytics-taxonomy.md](analytics-taxonomy.md)**, the shared
contract between this app and `com.nibe.local`, which report into the same Amplitude project. That
file is the source of truth for every event name, property name and property type; this file is the
privacy account of what leaves *this* device and why. Check the taxonomy before adding or renaming
anything here — and never edit it in one repo alone, the two copies must stay byte-identical.

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
| `Ran THEN Card` | A Flow action card ran | `card`, `role`, `ok` |
| `Checked AND Card` | A Flow condition card was evaluated | `card`, `role`, `ok`, `result` |
| `Changed Capability` | A capability was written from outside the app | `capability`, `role`, `control_mode`, `applied`, and `direction` on an applied `target_power` write |
| `Changed Device Set` | A device was added or removed | `action`, `role` |
| `Completed Detection` | A pairing or repair attempt finished | `mode`, `method`, `found`, `found_nothing` |
| `Lost Connection` | A device became unreachable | `cause`, `role` |
| `Restored Connection` | It became reachable again | `role` |
| `Raised Alarm` | The battery entered an unrecognised operating state | `role`, `op_state` |

Every event additionally carries `app`, merged in at the single `track()` choke point.

Every **device-scoped** event carries `role` — which part of the installation it happened on:
`battery`, `grid` or `solar`. Without it, "which part was this?" is unanswerable for this app, and a
cross-app chart grouped by `role` silently drops its rows. `grid` vs `solar` is decided by device
*class*, not driver id (see `analyticsRole()` in each device file): the `homevolt-sensor` driver
hosts both the grid sensor and solar sensors paired before solar got its own driver.

### Per-event notes

- **`Ran THEN Card` / `Checked AND Card`** are emitted by the `trackedRunListener()` wrapper, applied
  once at the single block in `device.js` where all twelve Flow cards are registered. `card` is the
  card id (`grid_charge_now`, `charge_battery`, …); `ok` says whether it threw. Card *arguments* —
  including power values and time windows — are never included. `role` is always `battery`: every
  Flow card this app has belongs to the battery driver, so it is passed at registration rather than
  read off the targeted device at run time.

  There is no `Fired WHEN Card` event for this app. Its only trigger card,
  `battery_status_changed`, is never fired by app code at all — Homey automatically runs a Flow
  trigger card whose id is `<capability_id>_changed` when `setCapabilityValue()` is called for a
  custom capability, and `battery_status` is a custom string capability. So there is no run
  listener to wrap. Reporting from the capability write instead would count *state transitions*,
  which the poll loop produces whether or not a single Flow subscribes to them — a different
  question from "did a Flow run", and one already answered by `Raised Alarm`.

- **`Changed Capability`** only fires when something outside the app writes a capability — the device
  tile, the mobile app, a Flow, or the web API. The poll loop updates values without triggering it,
  so every occurrence is genuinely a hand on a control. Only the three control capabilities are
  instrumented (`battery_control_mode`, `target_power_mode`, `target_power`); readings are not
  written from outside the app at all.

  Every one of them sends the same four keys — `capability`, `role`, `control_mode`, `applied` —
  through one helper (`reportCapabilityWrite()` in the battery device), so one event name means one
  shape. `applied` is `false` only for a `target_power` write rejected because the battery was under
  partner-cloud control; a mode write is always acted on. `direction` (`charge` / `discharge` /
  `idle`) is the single conditional property, present only on an applied `target_power` write —
  never the watt value.

- **`Completed Detection`** is the highest-value event here. `method` distinguishes `mdns` from
  `manual`, and `found_nothing` is the only signal that discovery silently failed on a network the
  author cannot test against. Somebody typing an IP by hand *is* the finding.

- **`Lost Connection` / `Restored Connection`** are **edge-triggered** — they fire on the transition
  only. Polling runs every 5 seconds by default, so a device that is off for an hour would
  otherwise produce ~720 identical events, drowning the project's quota and making one outage look
  like an epidemic. All three drivers report them, through one shared helper
  (`trackConnectionState()`), since all three poll the same hub and fail the same way; `role` says
  which one. The only property besides `role` is `cause: 'poll_failed'`.

  There is deliberately **no `reason`**. It used to carry the caught `Error.message`: unbounded free
  text, and near-constant in practice anyway, because the app's fetch helper returns `null` after
  exhausting its retries and the underlying cause is already lost by the time the event is built.

- **`Raised Alarm`** fires when `op_state_str` becomes something other than `charging`,
  `discharging` or `idle` — the three values seen on real units.
  [docs/console-help.md](console-help.md) does not enumerate the rest, so the unrecognised states
  are precisely the ones worth learning about: each is either a fault or a state this app should be
  handling. The raw state string is sent as `op_state`, with `role: 'battery'`. Also edge-triggered.

### Property names shared with the other app

Because one Amplitude project serves several apps (see above), a property name means the same thing
in all of them or it is useless for filtering — which is what
[docs/analytics-taxonomy.md](analytics-taxonomy.md) exists to keep true. Three names are therefore
deliberately *not* the obvious ones:

- **`op_state`, not `code`.** The project defines `code` as a numeric Nibe alarm code. This app's
  equivalent is a free-form firmware string, and one property cannot usefully be both a number and
  a string.
- **`role`, not `driver`.** The project already has `role` for "which part of the installation did
  this happen on" — a Nibe pump pairs as up to six function devices (`main`, `heating`, `hotwater`,
  `pool`, `cooling`, `solar`). This app's drivers are the same idea, so they reuse the name with
  bare values rather than raw driver ids: `battery`, `grid`, and `solar`. `solar` then means the
  same thing in both apps. Note `grid` vs `solar` is decided by device *class*, not driver — the
  `homevolt-sensor` driver hosts both the grid sensor and solar sensors paired before solar got its
  own driver.
- **`control_mode`, not `mode`.** The project defines `mode` as `pair`/`repair` on
  `Completed Detection`, which this app also uses that way. The `homey`/`partner` control mode
  needs its own name rather than a second, unrelated value set on `mode`.

Check [docs/analytics-taxonomy.md](analytics-taxonomy.md) before adding or renaming a property here;
a name that already exists elsewhere must keep its meaning *and* its type, and a concept that
already has a name must reuse it. That file is byte-identical in both repos — a change belongs in
both or in neither.

## User properties

Sent as an Amplitude `Identify` from `reportInstallProfile()`, debounced by 5 seconds so several
devices initialising at once collapse into one call. These describe what the install *is*, rather
than what it did, because the useful questions are cross-sectional ("of the 3-pack installs, how
many run in partner mode?") — a segmentation, not an event count.

The profile is assembled by `syncInstallProfile()` in [app.js](../app.js) and sent once per device
init, from **every** driver. It used to be sent from the battery device's `initSettings()` alone,
which meant a home that paired only a grid sensor sent no profile at all — the app enumerates
devices across all three drivers instead, so the profile is the same shape whichever are paired.

| Property | Source |
|---|---|
| `app`, `app_version` | App manifest |
| `roles` | Which parts this install has: `battery`, `grid`, `solar` — the set of `role` values across every paired device, deduplicated and sorted |
| `role_count` | Length of `roles`, because Amplitude cannot group by array length |
| `firmware` | `ems[0].ems_info.fw_version` from `ems.json` (e.g. `v31.3-6-gbe336a`) — the EMS firmware, which is what decides which console commands and schedule parameters exist. Sent **raw**, never mapped to a marketing name: a wrong guess here is unfixable, a wrong guess in Amplitude is reversible. Serial numbers sit next to it in the same payload and are never sent |
| `battery_packs` | Count of `bms_info` entries across all EMS entries |
| `rated_capacity_kwh` | Summed `bms_info.rated_cap` |
| `rated_power_w` | Summed `ems_info.rated_power` |
| `control_mode` | `target_power_mode` — `homey` or `partner` |
| `homey_version`, `homey_platform`, `homey_platform_version` | Homey SDK, reported raw rather than mapped to a product name, since that mapping is Athom's to change |
| `timezone` | The country signal — `Europe/Stockholm` resolves to a country without embedding an IANA→ISO table that goes stale |
| `language`, `units` | Locale, not location: plenty of Swedish users run Homey in English |

`roles` and `role` are the same vocabulary at two scopes, and neither derives from the other: a
device that is paired but never triggers anything emits no events for its role, and absence of
events is not absence of hardware. The battery-only properties are simply absent on an install with
no battery paired.

## Turning it off

Settings → Privacy → untick. Tracking stops on the next event. To also discard the anonymous id,
remove the app; app settings go with it.

## Where the code lives

| File | Role |
|---|---|
| [docs/analytics-taxonomy.md](analytics-taxonomy.md) | The shared contract with `com.nibe.local`: authoritative for every name and type |
| [lib/analytics.js](../lib/analytics.js) | The whole surface: consent gate, id minting, `track()`, `reportInstallProfile()`, `trackedRunListener()`, `trackConnectionState()` |
| [app.js](../app.js) | `initAnalytics()`, `Started App`, the consent settings listener, `hostFacts()`, `syncInstallProfile()`, the firmware latch |
| [drivers/homevolt-battery/device.js](../drivers/homevolt-battery/device.js) | Flow card wrapping, capability events, connection/op-state reporting, the battery half of the install profile |
| [drivers/homevolt-battery/driver.js](../drivers/homevolt-battery/driver.js) | `Completed Detection`, pairing consent handlers |
| [drivers/homevolt-sensor/device.js](../drivers/homevolt-sensor/device.js) | `role` from device class, device-set and connection events for the grid (and legacy solar) sensor |
| [drivers/homevolt-solar-panel/device.js](../drivers/homevolt-solar-panel/device.js) | Device-set and connection events for solar |
| [settings/index.html](../settings/index.html) | The Privacy toggle |
| [drivers/homevolt-battery/pair/list_devices.html](../drivers/homevolt-battery/pair/list_devices.html) | The pairing consent checkbox |

## Sharp edges

- **The ingestion key and the server zone must move together.** The key is scoped to its project's
  region; an EU key against the US endpoint is rejected outright.
- **The key is shared with the other Homey apps by design.** Do not mint a per-app key — that would
  split the data into projects Amplitude cannot chart across, which is the exact outcome the `app`
  property exists to avoid.
- **Adding an event or property means updating this file** *and* checking
  [docs/analytics-taxonomy.md](analytics-taxonomy.md) first. This file is the only record of what
  leaves the device, so it is only true if it is maintained; the taxonomy is the only thing keeping a
  name from meaning two things in one Amplitude project.
- **A user property that stops being written keeps its last value forever.** The identify only ever
  `.set()`s; there is no unset, so renaming one orphans the old name permanently.
- **Nothing calls `flush()` on shutdown**, so up to ~10 seconds of events can be lost on an app
  restart. Acceptable: this is product analytics, not billing.
