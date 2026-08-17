# Homevolt local console API reference

The battery exposes a local, unauthenticated console over HTTP at
`http://<ip>/console.json` (POST, form field `cmd`), implemented by
`sendBatteryCommand()` in [drivers/homevolt-battery/device.js](drivers/homevolt-battery/device.js).
This is an unsanctioned/reverse-engineered API (see [README.md](README.md)) — there is no
public spec, so this file is the only record of which commands/params exist and what they mean.

Full `help` output was captured verbatim from a real unit on 2026-08-11 (ecu-hub-esp32 firmware)
and is stored in **[docs/console-help.md](docs/console-help.md)** — that file is the authoritative
reference for which commands and flags exist. Only the parts relevant to this app are summarized
below; the ESP32 console also exposes a large number of unrelated system/diagnostic commands
(wifi, LTE, OTA, coredump, Modbus, heap tracing, etc.) not used here.

Anything not present in that capture should be assumed not to exist. Two commands this app used to
send were fixed after the capture proved they were never valid: `sched_add --cond_type=...` (no such
option) and `param_dump` (no such command — it is `param_list`). Because `sendBatteryCommand()`
throws on any response containing "invalid" or "error", an unknown flag is a hard failure, not a
silently ignored one.

## Debug logging convention

`app.js` and `device.js` each define `const DEBUG = process.env.DEBUG === '1'` at the top of the
file — Homey only sets that env var for `homey app run` (dev) sessions, never on an installed or
published app. Routine success-path logs that would otherwise fire on every single poll/command
(e.g. `[fetch] GET ...`, `[console] POST cmd=...`) are gated behind `if (DEBUG)`. Failure/error
logs (retries, non-OK responses, device error strings) stay unconditional, since those are rare
and worth seeing even on a live install.

## Local vs. remote control

- `param_get settings_local` / `param_set settings_local <true|false>` (+ `param_store` to persist
  to flash) — the *only* local/remote toggle the firmware exposes:
  - `true` = the local (LAN) console is authoritative. Homey can change the schedule, and so can
    anyone using the battery's own local UI directly.
  - `false` = the partner cloud (Tibber/Svea/etc.) controls the battery. All local power commands,
    including Homey's, get rejected.
  - This is a single bit, not three states. Whatever is currently loaded on the device (a full
    schedule from `sched_add`, or a single override entry from `sched_set`) just keeps running
    statelessly regardless of whether Homey is online, offline, or was ever involved in writing it
    — Homey's liveness doesn't change device behavior. An earlier version of this app modeled
    `settings_local=true` as two separate app-level modes ("local schedules" vs. "Homey
    controlled"), reasoning that "local" was more resilient if Homey went offline — that reasoning
    was wrong (see "Control-mode capabilities" below) and the distinction was dropped.
- `param_list [-dn]` / `help` — fallback ways to read current param state on older firmware that
  doesn't support `param_get` directly (see `syncBatteryControlMode()`). `param_list` dumps
  key/value pairs, so the same `settings_local <true|false>` parse works on both. (`param_dump`
  was in this chain historically; no firmware has ever had that command.)

## Scheduling / setpoint commands

- `sched_add <type> [--from=... --to=... -s <setpoint> ...]` — add a schedule entry.
- `sched_set <type> [-s <setpoint> ...]` — replace the current schedule with one entry (used for
  immediate "force charge/discharge now" actions).
- `sched_clear` — clear **all** schedules (including the user's own local schedules — do not call
  this as a side effect of switching control modes).
- `sched_list` / `sched_del <id>` — inspect/remove individual schedule entries.
- `<type>` values: `0 = idle`, `1 = inv-charge`, `2 = inv-discharge`, `3 = grid-charge`,
  `4 = grid-discharge`, `5 = grid-charge/discharge`, `6 = freq-reserve`.
  - Force charge uses type `1` (`sched_set 1 -s <watts>`).
  - Force discharge uses type `2` (`sched_set 2 -s <watts>`).
  - Idle/stop is its own dedicated type `0` (`sched_set 0`) — **not** `sched_set 1 -s 0`.

### Where the setpoint is measured (inverter vs. grid)

This is the one thing the type numbers encode that isn't obvious: types `1`/`2` measure `-s` at the
**inverter** (i.e. battery power), while types `3`/`4`/`5` measure it at the **grid connection
point**. With a grid type the battery continuously adjusts its own output so that the *meter* reads
the requested value — so e.g. `sched_set 4 -s 0` means "cover the house load exactly, import
nothing", and the actual battery power varies with load.

Consequences, both encoded in `applyGridSetpoint()`:

- `assertPowerWithinRatedLimit()` must **not** be applied to grid setpoints. It bounds against the
  battery's rated power, but a grid target is a target at the meter — an 18 kW house draw is a
  legitimate grid setpoint on a 12 kW battery, and a negative setpoint would pass it vacuously.
  The flow cards' own `min`/`max` (±30000 W) are the only bound.
- Type `5` is bidirectional, so its setpoint is signed: positive = import from grid, negative =
  export to grid, `0` = hold the connection at zero (self-consumption). The `-i/--idle_threshold_power`
  and `-r/--discharge_threshold_power` flags exist to give it a deadband; this app doesn't set them.

  **Verified on a real unit, 2026-08-11.** `sched_set 5 -s -3000` was accepted and `sched_list`
  echoed it back unchanged, so the firmware genuinely takes a signed setpoint here:

  ```
  id: 0, type: Grid charge/discharge setpoint, from: 2026-08-11T21:48:27, to: <unset>,
  setpoint:-3000, max_charge: <max allowed>, max_discharge: <max allowed>
  ```

  Two incidental facts from that output: `sched_set` stamps `from` to the moment it ran and leaves
  `to` unset (so the entry runs indefinitely until replaced or idled), and `max_charge` /
  `max_discharge` default to `<max allowed>` when `-c` / `-d` aren't passed.

### Flags accepted by `sched_add` / `sched_set`

Both take the exact same flag set. The full list is in [docs/console-help.md](docs/console-help.md);
these are the ones that matter here:

| Flag | Meaning | Used by this app |
|---|---|---|
| `-s`, `--setpoint` | Power setpoint (W), frame depends on `<type>` | yes — every power card |
| `--from`, `--to` | Window bounds, `YYYY-MM-DDTHH:mm:ss` | yes — the `plan_*`/`charge_battery` cards |
| `--min`, `--max` | Min/max SoC for the entry | no |
| `-c`, `--max_charge` / `-d`, `--max_discharge` | Clamp battery power inside a grid-mode entry | no — candidate for bounding the battery side of grid setpoints |
| `-l`, `--import_limit` / `-x`, `--export_limit` | Hard grid import/export limits | no |
| `--main_fuse` | Main fuse size in **mA** | no |
| `--charge_ramp_up` / `--discharge_ramp_up` | Ramp rate in mA/s | no |
| `--import_energy_limit*` / `--export_energy_limit*` | Energy (Wh) budgets with their own from/to windows and max compensation power | no |
| `-n`/`-u`/`-w`/`-f`, `--fcr_*`, `--ffr_*`, `-t`, `-e`, `-a`, `-m` | Frequency-reserve (FCR-N / FCR-D / FFR) params and test sequences, for type `6` | no |
| `-o`, `--offline` | Take the inverter offline during idle | no |

Command lines are assembled by `buildScheduleCommand(verb, type, { setpoint, from, to })` in
device.js — the single place that knows the flag spelling. Add new flags there rather than
string-building in a flow card listener.

## Control-mode capabilities (target_power_mode / battery_control_mode)

Two Homey capabilities on `homevolt-battery` represent the same underlying `settings_local`
firmware flag:

- `target_power_mode` (Homey-native system capability, values `homey`/`partner`) — the current
  model. Paired with the Homey-native `target_power` capability (Watts). Homey auto-generates the
  trigger/condition/action Flow cards for both directly from the capability definition (see
  `capabilitiesOptions.target_power_mode.values` in
  [driver.compose.json](drivers/homevolt-battery/driver.compose.json)) — no hand-written flow
  card JSON needed for these two.
- `battery_control_mode` (legacy custom capability, values `local`/`remote`) — superseded by
  `target_power_mode`. Its flow card (`set_battery_control_mode`) is `"deprecated": true` in
  [driver.flow.compose.json](drivers/homevolt-battery/driver.flow.compose.json) (hidden from the
  picker for new Flows, still functional for existing ones), and its device-UI tile is hidden via
  `capabilitiesOptions.battery_control_mode.uiComponent: null` in driver.compose.json (still fully
  gettable/setable programmatically, just not shown on the device screen). Kept only for
  backwards compatibility with Flows/automations built before `target_power_mode` existed.

### Mode -> firmware mapping

| target_power_mode | settings_local | legacy battery_control_mode |
|---|---|---|
| `homey`   | `true`  | `local`  |
| `partner` | `false` | `remote` |

This maps 1:1 onto the single real firmware bit (see "Local vs. remote control" above) — no
ambiguity, no bookkeeping needed to tell modes apart on resync.

**Why there's no third "local schedules" mode**: an earlier version of this logic had one,
reasoning that the device's own schedule would keep running if Homey went offline, unlike a
Homey-pushed setpoint. That's false: `settings_local=true` just means the local console is
authoritative full stop, and whatever's currently loaded (a full `sched_add` schedule or a single
`sched_set` override) runs the same way whether Homey is online or offline, since neither depends
on Homey's continued involvement to keep executing. The only actor that can override or reject
local commands is the partner cloud, which is exactly what `partner` (`settings_local=false`)
already models. So there was no real distinction left to represent — `homey` now just means
"the local console is authoritative," regardless of whether Homey, or a human using the battery's
own local UI, is the one currently driving it.

### Key methods in device.js

- `isLocalControlMode(mode)` — `mode !== 'partner'`; the mode -> `settings_local` mapping.
- `applySettingsLocal(isLocal)` — writes `param_set settings_local <bool>` + `param_store`.
- `applyControlModeCapabilities(mode)` — capability-only side effects (mirrors both control-mode
  capabilities); no firmware I/O. Used both by `setControlMode()` and, read-only, by
  `syncBatteryControlMode()`.
- `setControlMode(mode)` — the single place that actually changes the mode: calls
  `applySettingsLocal()`, then `applyControlModeCapabilities()`, and — on any actual mode change
  (`previousMode !== mode`) — also sends `sched_set 0` to idle the schedule. Toggling
  `settings_local` alone does **not** clear whatever schedule is currently loaded, so this idle is
  needed on both sides of the transition:
  - Entering `homey`: without it, a schedule the partner cloud pushed while `settings_local` was
    `false` stays loaded and keeps running under the `homey` label, since nothing has told the
    device otherwise yet - this was an observed real bug ("mode says homey, battery still follows
    partner"), not just a theoretical concern.
  - Leaving `homey`: a previously-pushed `target_power` setpoint shouldn't keep running after
    control is handed to the partner cloud - per Homey's docs, "any non-homey value means the
    device controls its own power."

  Called from the deprecated flow card, the legacy `battery_control_mode` capability listener, and
  the `target_power_mode` capability listener — never call `applySettingsLocal` +
  `applyControlModeCapabilities` directly outside of this method or `syncBatteryControlMode()`.
- `syncBatteryControlMode()` — runs once on device init. Reads `settings_local` off the device
  (tries `param_get`, then `param_dump`, then `help`, for older firmware) and reflects it via
  `applyControlModeCapabilities()` only — it never writes `settings_local` back, since it's purely
  reporting current state, not changing it.
- `applyTargetPower(power)` — sends the signed setpoint to the firmware (see mapping below) as a
  direct, one-shot override. Deliberately does **not** touch `target_power_mode`/`settings_local` -
  used both by the `target_power` capability listener (once it has confirmed mode is `'homey'`) and
  directly by the deprecated `force_charge`/`force_discharge` cards (see below for why those must
  NOT go through a mode switch).

### target_power handling

The combined `registerMultipleCapabilityListener(['target_power_mode', 'target_power'], ..., 500)`
listener only acts on a `target_power` write when `target_power_mode === 'homey'` at that point;
any other mode silently ignores the write (Homey's own auto-generated `target_power_set` Flow card
switches mode to `homey` itself before pushing a setpoint, per Homey's docs, so this should never
normally trigger in practice).

- `target_power > 0` -> `sched_set 1 -s <power>` (charge)
- `target_power < 0` -> `sched_set 2 -s <abs(power)>` (discharge)
- `target_power == 0` -> `sched_set 0` (idle - a dedicated type, not `sched_set 1 -s 0`)

Every power value is checked with `assertPowerWithinRatedLimit()` against the battery's actual
detected rated power (summed from EMS data) before being sent.

### Deprecated legacy actions

`force_charge` and `force_discharge` (unconditional, immediate `sched_set` commands, one positive
watt argument each) predate `target_power`/`target_power_mode`, so both are `"deprecated": true` in
driver.flow.compose.json (hidden from the picker for new Flows, still work for existing ones).

They deliberately call `applyTargetPower(power)` directly, **not** anything that would switch
`target_power_mode` to `'homey'` first. Per Homey's docs, that mode switch is a *persistent*
hand-off ("when switching from homey to device mode, the driver should discard any setpoint and
resume internal device logic"), not scoped to a single command. If these cards routed through the
mode switch (as an earlier version of this logic did), a one-off "force charge now" while in
`partner` mode would silently and permanently pull the battery out of partner control - a much
bigger side effect than the user asked for. So they stay mode-agnostic overrides that work exactly
like they did before `target_power`/`target_power_mode` existed (an unconditional `sched_set`,
which the firmware will simply reject if the device is currently in `partner` mode) - the only
thing shared with the new capability is the `sched_set`-building logic in `applyTargetPower()`.

`charge_battery`/`discharge_battery` (scheduled, with a from/to time window via `sched_add`) are
**not** deprecated — Homey's `target_power` has no time-window concept, so there's no native
equivalent to point people at.

### Grid-relative actions

Six cards drive schedule types `3`/`4`/`5`, where the setpoint is measured at the grid connection
point (see "Where the setpoint is measured" above). None of them are deprecated and none have a
Homey-native equivalent — `target_power` is inverter-referenced by definition.

| Card | Command |
|---|---|
| `grid_charge_now` | `sched_set 3 -s <W>` |
| `grid_discharge_now` | `sched_set 4 -s <W>` |
| `grid_setpoint_now` | `sched_set 5 -s <signed W>` |
| `plan_grid_charge` | `sched_add 3 -s <W> --from=… --to=…` |
| `plan_grid_discharge` | `sched_add 4 -s <W> --from=… --to=…` |
| `plan_grid_setpoint` | `sched_add 5 -s <signed W> --from=… --to=…` |

All six are registered from a single table in `onInit()` and route through
`applyGridSetpoint(type, watts, window)`, which — exactly like `applyTargetPower()`, and for the
same reason — deliberately does **not** touch `target_power_mode`/`settings_local`. They are
one-shot overrides, not a persistent hand-off of control to Homey. The `_now` variants use
`sched_set` (replacing the current schedule, so it takes effect immediately); the `plan_` variants
use `sched_add` (appending alongside whatever else is scheduled).

## Other useful params

- `ems` — show EMS (inverter) info (used for rated power / status polling elsewhere in the app).
- `energy [-n <name>] [-i <kWh>] [-e <kWh>] [-s]` — list/modify energy counters.

# Homey Energy configuration

The `energy` block lives in each driver's `driver.compose.json` and **should stay there**. Two rules,
both learned the hard way:

## A home battery is never `cumulative`

`cumulative` marks a *whole-home* meter (P1 meter, current clamp): Homey subtracts every other
device's usage from cumulative devices and reports the remainder as "other". Getting this wrong
corrupts the entire Energy dashboard, not just the offending device's tile.

- `homevolt-battery` -> `{homeBattery, batteries: ["INTERNAL"], meterPowerImportedCapability,
  meterPowerExportedCapability}`. This matches what every other Homey home battery ships (Victron,
  SMA, GivEnergy, Sigenergy all use `homeBattery` + `meterPower*`).
- `homevolt-sensor` -> `{cumulative, cumulativeImportedCapability, cumulativeExportedCapability}`.
  This is the grid sensor, and it is byte-identical to what Tibber's Pulse (a P1 meter) declares.
  **The sensor already fills the cumulative role, which is exactly why the battery must not.**

`meter_power.imported`/`.exported` are deliberately *not* renamed to `.charged`/`.discharged`. Any
`meter_power` instance is a legal target for `meterPower*Capability`; other apps use the `.charged`
spelling only because they picked it first. Renaming would destroy users' Insights history and break
existing Flows.

An `energy-settings` / `isSmartMeter()` handler that set `cumulative: true` on the battery lived in
device.js from v1.4.0 (2025-06-05) until it was removed. It never fired — Homey offers no
smart-meter setting on a `class: battery` device, whose Advanced Settings expose only "Exclude from
Energy" — but it was copied from a docs snippet meant for P1 meter apps. Don't reintroduce it.

## `setEnergy()` is a one-way door

`Device.setEnergy()` takes the **complete** energy object and overwrites every existing property.
Worse, once it has been called, that device **ignores `driver.compose.json`'s `energy` block
forever** — the SDK documents no way to clear an override.

Consequences:

- Never call `setEnergy()` with a partial object. The removed handler passed only the `cumulative*`
  properties, which would have silently dropped `batteries` and both `meterPower*Capability`
  pointers from any device that hit it.
- Never call it unconditionally on init. That *creates* an override on a healthy device and detaches
  it from the manifest permanently — a far worse outcome than whatever it was meant to fix.
- If a device ever does need repairing, guard the call on detecting the bad state first, and mirror
  any future manifest energy change into that repair code, or repaired devices will silently keep the
  old config. `migrateLegacySolarDevice()` in
  [drivers/homevolt-sensor/device.js](drivers/homevolt-sensor/device.js) is the in-place migration
  idiom to copy: idempotence check, plus a log line on both branches so the app log says whether the
  patch applied or was already applied.

# Analytics

Anonymous, opt-in product analytics via Amplitude. The whole surface is
[lib/analytics.js](lib/analytics.js); **[docs/analytics.md](docs/analytics.md) is the
source-of-truth privacy document and must be updated whenever an event or property changes** — it
is the only record of what leaves the device, so it is only true if it is maintained.

Things that are not obvious from the code:

- **The Amplitude project is shared with `com.nibe.local`** (and any future Homey app by the same
  author). One ingestion key, one project; the `app` property — read from `manifest.id`, merged in
  at the single `track()` choke point — is what separates them again. Do **not** mint a per-app
  key: Amplitude charts cannot span projects, so splitting would permanently foreclose cross-app
  questions, and merging afterwards is not possible without re-ingesting.
- **`lib/analytics.js` is deliberately kept diffable against `com.nibe.local/lib/analytics.ts`**,
  which is the same module in TypeScript. Since both apps report into one project, the taxonomies
  have to stay in step, and reading the two files side by side is how that is maintained. Keep the
  event names, the setting keys (`analytics_consent`, `analytics_device_id`) and the function
  shapes aligned; prefer porting a change to both over letting them drift.
- **`SERVER_ZONE` and `API_KEY` move together.** An ingestion key is scoped to its project's
  region, and the SDK's default zone is `US`, which would reject the EU key outright.
- **Identity is a random UUID per app, minted only after consent.** Homey sandboxes app settings,
  so one Homey running two of these apps counts as two Amplitude users. That is intentional (see
  docs/analytics.md); do not "fix" it by deriving a shared id from the Homey id without treating
  it as the privacy-posture change that it is.
- **Anything fired from the poll loop must be edge-triggered.** Polling defaults to 5 seconds, so
  a per-poll event is ~720 events an hour per device. `reportConnectionState()` and
  `reportOpState()` both guard on a stored last value for this reason.
- **Never send raw `cmd` strings.** `buildScheduleCommand()` output embeds setpoints and wall-clock
  timestamps. Events carry the flow card id and, at most, a direction — never the assembled
  command or the watt value.
- **A property name means the same thing in every app, or it is useless.** Because one project
  serves several apps, check the project's existing taxonomy before adding a property — a name that
  already exists must keep its meaning *and its type*, and a concept that already has a name must
  reuse it. Three names here are deliberately not the obvious ones: `op_state` rather than `code`
  (the project's `code` is a numeric Nibe alarm code; this is a free-form string), `control_mode`
  rather than `mode` (the project's `mode` is `pair`/`repair`, which this app also uses on
  `Completed Detection`), and `role` rather than `driver` (the project's `role` already means
  "which part of the installation" — Nibe's six function devices — so this app's drivers reuse it
  with bare values like `battery`, not raw driver ids; `solar` then means the same in both apps).
  All three were shipped and caught in review — read the plan first, not after.
- Flow **trigger** cards are not instrumented, and `battery_status_changed` could not be even if
  we wanted to: Homey auto-runs a trigger card whose id is `<capability_id>_changed` when
  `setCapabilityValue()` is called for a **custom** capability, so that card fires without any app
  code and has no run listener to wrap. (This is also why the card works despite `grep -rn
  "\.trigger("` finding nothing — it is not dead code.) Instrumenting the capability write instead
  would count state transitions from the poll loop rather than Flow activity.
