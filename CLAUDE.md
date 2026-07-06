# Homevolt local console API reference

The battery exposes a local, unauthenticated console over HTTP at
`http://<ip>/console.json` (POST, form field `cmd`), implemented by
`sendBatteryCommand()` in [drivers/homevolt-battery/device.js](drivers/homevolt-battery/device.js).
This is an unsanctioned/reverse-engineered API (see [README.md](README.md)) — there is no
public spec, so this file is the only record of which commands/params exist and what they mean.

Full `help` output was captured from a real unit on 2026-07-06 (ecu-hub-esp32 firmware).
Only the commands relevant to this app are summarized below; the ESP32 console also exposes a
large number of unrelated system/diagnostic commands (wifi, LTE, OTA, coredump, etc.) not used here.

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
- `param_dump` / `help` — fallback ways to read current param state on older firmware that
  doesn't support `param_get` directly (see `syncBatteryControlMode()`).

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

## Other useful params

- `ems` — show EMS (inverter) info (used for rated power / status polling elsewhere in the app).
- `energy [-n <name>] [-i <kWh>] [-e <kWh>] [-s]` — list/modify energy counters.
