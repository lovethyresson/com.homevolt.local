# Shared analytics taxonomy

**This file is identical in `com.nibe.local` and `com.homevolt.local`. Do not edit one copy alone.**

Both apps report into a single Amplitude project. That only works if a name means the same thing in
both — otherwise a cross-app chart silently mixes incompatible values and the shared project is
worse than two separate ones. This file is the contract. Each app's own `docs/analytics.md` keeps
its privacy prose and links here for names and types.

## Rules

1. **Check this file before adding any property.** A name that already exists keeps its meaning
   *and its type*. A concept that already has a name reuses that name.
2. **If a name does not fit, pick a new one** rather than overloading an existing one. Three
   collisions were shipped and caught only in review: `code` (numeric, Nibe alarm) vs a free-form
   string → `op_state`; `mode` (`pair`/`repair`) vs control mode → `control_mode`; `driver` for a
   concept already called `role`.
3. **`app` is injected at the single `track()` choke point**, spread **last** so a call site cannot
   shadow it. Never pass it manually.
4. **Anything on a poll loop must be edge-triggered.** Homevolt polls every 5 s by default; a
   per-poll event is ~720/hour/device.
5. **Never send a raw command, reading, setpoint, address, or free-text error.** Direction, bucket
   or bounded enum only.
6. **A property that stops being written keeps its last value forever.** `Identify` uses only
   `.set()`; there is no unset. Renaming a user property orphans the old one permanently.

## Identity

Random UUID per app, minted only after consent, stored as `analytics_device_id`. No `user_id` ever.
Homey sandboxes app settings, so one Homey running both apps is **two** Amplitude users. Per-app
counts are exact; "how many run both" is deliberately unanswerable.

## `role` and `roles`

The same vocabulary at two scopes. `role` is an **event** property — which part of the installation
this event happened on. `roles` is a **user** property — which parts the install *has*.
`role_count` is its length (Amplitude cannot group by array length).

Neither derives from the other: an install that paired a device and never triggered anything emits
no events for that role, and absence of events is not absence of hardware.

| App | `role` values |
|---|---|
| nibe | `main`, `heating`, `hotwater`, `pool`, `cooling`, `solar`, `unknown` |
| homevolt | `battery`, `grid`, `solar` |

`solar` means the same thing in both. `unknown` is a bug, not a real value — treat it as one.
In homevolt, `grid` vs `solar` is decided by device **class**, not driver: the `homevolt-sensor`
driver hosts both the grid sensor and solar sensors paired before solar got its own driver.

## Events

`app` is on every event and omitted from the tables below.

| Event | Apps | Properties |
|---|---|---|
| `Started App` | both | `app_version` |
| `Ran THEN Card` | both | `card`, `role`, `ok`; `register` (nibe) |
| `Checked AND Card` | both | `card`, `role`, `ok`, `result`¹; `register` (nibe) |
| `Fired WHEN Card` | nibe | `card`, `register`, `role` |
| `Clicked Button` | nibe | `view`, `button` |
| `Changed Capability` | both | `capability`, `role`; `control_mode`, `applied`, `direction`² (homevolt) |
| `Changed Device Set` | both | `action`, `role`; `groups_enabled`³ (nibe) |
| `Completed Detection` | both | `mode`, `found_nothing`; `registers_responded`, `registers_total`, `groups_recommended` (nibe); `method`, `found` (homevolt) |
| `Lost Connection` | both | `cause`; `dead_polls`⁴ (nibe); `role` (homevolt)⁷ |
| `Restored Connection` | homevolt | `role`⁷ |
| `Raised Alarm` | both | `code` (nibe); `role`, `op_state` (homevolt)⁵ |

¹ `result` is present only on success. When the listener throws, `ok: false` and no `result` — nothing
was evaluated. Intentional in both apps.
² `direction` only when `applied: true` on `target_power`.
³ Only with `action: 'reconfigured'`.
⁴ Only with `cause: 'watchdog'`.
⁵ `role` is homevolt-only here on purpose. In nibe the alarm register lives only on the `main`
device, so `role` would be a constant — a property with one value is noise, not a dimension. In
homevolt any of the three roles can report an unrecognised operating state.
⁷ `role` is homevolt-only on the connection events for an architectural reason, not an oversight. In
homevolt each device polls and tracks its own reachability, so the failure *has* a role. In nibe the
event comes from `PumpConnection`, which is shared per host and is not a Homey device at all — there
is no role at that layer to report, and inventing one would be a lie.

**Not instrumented, deliberately:** Flow *trigger* run listeners. Homey calls them once per
subscribed Flow, so wrapping them counts subscriptions rather than fires. Homevolt's one trigger
(`battery_status_changed`) is auto-run by Homey from `setCapabilityValue()` on a custom capability,
so it has no listener at all.

## Event properties

| Property | Type | Values | Apps |
|---|---|---|---|
| `app` | string | `com.nibe.local`, `com.homevolt.local` | both, injected |
| `app_version` | string | manifest version | both (`Started App` only) |
| `role` | string | see above | both |
| `card` | string | Flow card id | both |
| `register` | string | Modbus register as a capability id | nibe |
| `ok` | boolean | did the run listener throw | both |
| `result` | boolean | what an AND card evaluated to | both |
| `capability` | string | Homey capability id | both |
| `control_mode` | string | `homey`, `partner` | homevolt |
| `applied` | boolean | was the write acted on — `false` only for a `target_power` write rejected because the mode was not `homey`. A mode write is always acted on, so `true` | homevolt |
| `direction` | string | `charge`, `discharge`, `idle` | homevolt |
| `action` | string | `added`, `removed`, `reconfigured` | both |
| `groups_enabled` | string[] | feature groups left on | nibe |
| `mode` | string | `pair`, `repair` | both |
| `method` | string | `mdns`, `manual` | homevolt |
| `found` | number | devices found | homevolt |
| `found_nothing` | boolean | ran but identified nothing | both |
| `registers_responded` | number | registers that answered | nibe |
| `registers_total` | number | size of the app's register table for this pump family — the denominator for `registers_responded`⁶ | nibe |
| `groups_recommended` | string[] | feature groups detection suggested | nibe |
| `cause` | string | `watchdog`, `socket_close` (nibe); `poll_failed` (homevolt) | both |
| `dead_polls` | number | consecutive empty polls before the watchdog tripped | nibe |
| `code` | **number** | Nibe alarm code, as reported | nibe |
| `op_state` | **string** | firmware operating state the app does not recognise | homevolt |
| `view` | string | which of the app's own web views | nibe |
| `button` | string | which button | nibe |

`code` and `op_state` are separate names on purpose: one is a number, one a free-form string, and one
property cannot usefully be both.

⁶ Not "registers attempted" — a known imprecision on the repair path, where detection can probe a
device-specific subset but the reported figure is still the whole profile's table. Described as the
denominator so it matches the value actually sent; tightening it would change a shipped number.

**Removed:** `prompt_version` (an Amplitude setup-wizard marker, no product meaning) and `reason` on
`Lost Connection` (raw `Error.message` — unbounded, and near-constant in practice since the fetch
helper returns `null` and loses the underlying cause before the event is built).

## User properties

Sent by `Identify` from `reportInstallProfile()`, debounced 5 s so several devices initialising at
once collapse into one call.

| Property | Type | Source | Apps |
|---|---|---|---|
| `app` | string | `manifest.id` | both |
| `app_version` | string | `manifest.version` | both |
| `roles` | string[] | the `role` values this install has — a **deduplicated, sorted set**, so `role_count` is comparable across apps even where one role can have two devices | both |
| `role_count` | number | length of `roles` | both |
| `firmware` | string | device firmware, raw | both |
| `homey_version` | string | `homey.version` | both |
| `homey_platform` | string | `local`, `cloud` | both |
| `homey_platform_version` | number | platform generation | both |
| `timezone` | string | IANA zone — **the country signal** | both |
| `language` | string | locale, **not location** | both |
| `units` | string | metric / imperial | both |
| `pump_model_code` | string | heat-pump type register, unmapped | nibe |
| `features_<role>` | string[] | feature groups on per role | nibe |
| `battery_packs` | number | count of battery packs | homevolt |
| `rated_capacity_kwh` | number | summed pack capacity | homevolt |
| `rated_power_w` | number | summed inverter rated power | homevolt |
| `control_mode` | string | `homey`, `partner` | homevolt |

`timezone` is the country signal; `language` is locale and must not be read as location. Model and
firmware codes are sent **raw**, never mapped to marketing names — the mapping varies by firmware and
a wrong guess in the app is unfixable, whereas a wrong guess in Amplitude is reversible.

## Never sent

Readings and measurements; setpoints in watts; assembled console commands; IP addresses, subnets,
wifi SSIDs; serial numbers and discovery hostnames; device, zone and Flow names; alarm description
text.

Amplitude sees the household public IP as the request origin and may derive coarse geography. That
is Amplitude's behaviour, not something either app sends; the Node SDK accepts a per-event `ip`
override at the `track()` choke point if it ever needs suppressing.
