const { Device } = require('homey');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { track, trackedRunListener, reportInstallProfile } = require('../../lib/analytics');

// Set by Homey only for `homey app run` (dev) sessions, not on installed/published apps.
const DEBUG = process.env.DEBUG === '1';

/**
 * The firmware's `sched_set`/`sched_add` <type> argument (see docs/console-help.md).
 * Types 1/2 measure their setpoint at the inverter (i.e. battery power); types
 * 3/4/5 measure it at the grid connection point instead, so the battery does
 * whatever it takes to hold the meter at the requested value.
 */
const SCHEDULE_TYPE = {
  IDLE: 0,
  INV_CHARGE: 1,
  INV_DISCHARGE: 2,
  GRID_CHARGE: 3,
  GRID_DISCHARGE: 4,
  GRID_CHARGE_DISCHARGE: 5,
};

/**
 * Convert a Homey flow-card date arg (DD-MM-YYYY) and time arg (HH:mm) into the
 * timestamp format the firmware's --from/--to flags expect (YYYY-MM-DDTHH:mm:ss).
 */
function toScheduleTimestamp(dateString, timeString) {
  const [day, month, year] = dateString.split('-');
  return `${year}-${month}-${day}T${timeString}:00`;
}

/**
 * Assemble a `sched_set`/`sched_add` command line. Only flags this firmware
 * actually accepts are emitted - docs/console-help.md is the reference for the
 * full set. (An earlier version of this app sent `--cond_type=1`, an option
 * `sched_add` has never had; the console answers unknown options with "invalid
 * option", which sendBatteryCommand() turns into a thrown error - so those
 * cards were failing outright.)
 */
function buildScheduleCommand(verb, type, { setpoint, from, to } = {}) {
  const parts = [verb, String(type)];
  if (setpoint !== undefined && setpoint !== null) parts.push(`-s ${setpoint}`);
  if (from) parts.push(`--from=${from}`);
  if (to) parts.push(`--to=${to}`);
  return parts.join(' ');
}

class HomevoltBatteryDevice extends Device {

  /**
   * Ensure a capability exists on the device, adding it if missing.
   * @param {string} capabilityId
   * @returns {Promise<boolean>}
   */
  async ensureCapability(capabilityId) {
    try {
      if (!this.hasCapability(capabilityId)) {
        this.log(`Missing capability '${capabilityId}' on device, adding it for backwards compatibility`);
        await this.addCapability(capabilityId);
      }
      return true;
    } catch (err) {
      this.error(`Failed to ensure capability '${capabilityId}':`, err);
      return false;
    }
  }

  /**
   * Total rated power across all EMS entries (watts), as reported by the
   * device itself - reflects however many battery packs are actually
   * installed, rather than assuming a fixed 6000W per pack.
   */
  computeRatedPowerWatts(data) {
    const emsList = Array.isArray(data?.ems) ? data.ems : [];
    return emsList.reduce((sum, ems) => sum + (ems?.ems_info?.rated_power || 0), 0);
  }

  /**
   * Reject a requested charge/discharge power that exceeds this device's
   * detected rated power. Skipped if rated power is unknown (0), since some
   * firmware may not report it and we don't want to block all commands.
   */
  assertPowerWithinRatedLimit(power) {
    if (this.ratedPowerWatts && power > this.ratedPowerWatts) {
      throw new Error(`Requested power (${power}W) exceeds this battery's rated power (${this.ratedPowerWatts}W)`);
    }
  }

  /**
   * Homey talks to the battery over the same local console API
   * (http://<ip>/console.json) that its own local UI uses. The firmware only
   * has one bit of state here, `settings_local`:
   * - true  = the local (LAN) console is authoritative: Homey can change the
   *   schedule, and so can anyone using the battery's own local UI. Maps to
   *   target_power_mode 'homey'.
   * - false = the partner cloud (Tibber/Svea/etc.) controls the battery; all
   *   local power commands, including Homey's, are rejected. Maps to
   *   target_power_mode 'partner'.
   * There's no third state - see CLAUDE.md for why an earlier version of this
   * logic had (and dropped) a separate 'local schedules' mode.
   */
  isLocalControlMode(mode) {
    return mode !== 'partner';
  }

  async applySettingsLocal(isLocal) {
    await this.sendBatteryCommand(`param_set settings_local ${isLocal ? 'true' : 'false'}`);
    await this.sendBatteryCommand('param_store');
  }

  /**
   * Reflect a target_power_mode value ('homey' | 'partner') onto the legacy
   * `battery_control_mode` (local/remote) capability and the newer
   * `target_power_mode` capability. Does not talk to the device - used both by
   * setControlMode() (which does talk to the device) and read-only by sync, to
   * reflect a mode detected on init without sending anything.
   */
  async applyControlModeCapabilities(mode) {
    if (this.hasCapability('battery_control_mode')) {
      await this.setCapabilityValue('battery_control_mode', mode === 'partner' ? 'remote' : 'local').catch(this.error);
    }
    if (this.hasCapability('target_power_mode')) {
      await this.setCapabilityValue('target_power_mode', mode).catch(this.error);
    }
  }

  /**
   * Actually change the control mode: writes settings_local to the firmware and
   * mirrors both control-mode capabilities. Toggling settings_local does NOT
   * clear whatever schedule is currently loaded on the device - so on any
   * actual mode change, also idles the schedule (sched_set 0) for a clean
   * handover in both directions:
   * - Entering 'homey': without this, a schedule the partner cloud pushed
   *   while settings_local was false stays loaded and keeps running under
   *   the 'homey' label, since nothing has told the device otherwise yet.
   * - Leaving 'homey': a previously-pushed target_power setpoint shouldn't
   *   keep running after handing control to the partner cloud - per Homey's
   *   docs, any non-homey mode means "the device controls its own power".
   */
  async setControlMode(mode) {
    const previousMode = this.hasCapability('target_power_mode') ? this.getCapabilityValue('target_power_mode') : undefined;

    await this.applySettingsLocal(this.isLocalControlMode(mode));
    await this.applyControlModeCapabilities(mode);

    if (previousMode !== undefined && previousMode !== mode) {
      try {
        await this.sendBatteryCommand('sched_set 0');
        this.log(`Control mode changed '${previousMode}' -> '${mode}'; idled the schedule for a clean handover`);
      } catch (err) {
        this.error('Failed to idle schedule on control mode change:', err);
      }
    }
  }

  /**
   * Send a signed power setpoint to the firmware - a direct, one-shot override
   * that does NOT touch target_power_mode/settings_local. Used both by the
   * target_power capability listener (once it has confirmed mode is 'homey')
   * and directly by the deprecated force_charge/force_discharge cards, which
   * are intentionally mode-agnostic overrides, not a persistent hand-off to
   * Homey (see the comment on force_charge below for why that matters).
   */
  async applyTargetPower(power) {
    this.assertPowerWithinRatedLimit(Math.abs(power));
    const command = power > 0
      ? buildScheduleCommand('sched_set', SCHEDULE_TYPE.INV_CHARGE, { setpoint: power })
      : power < 0
        ? buildScheduleCommand('sched_set', SCHEDULE_TYPE.INV_DISCHARGE, { setpoint: Math.abs(power) })
        : buildScheduleCommand('sched_set', SCHEDULE_TYPE.IDLE);
    await this.sendBatteryCommand(command);
    this.log(`Applied target_power=${power}W via '${command}'`);
  }

  /**
   * Send a grid-referenced setpoint (schedule types 3/4/5) to the firmware.
   *
   * The grid-side sibling of applyTargetPower(), with the same one-shot
   * override semantics: like that method it deliberately does NOT touch
   * target_power_mode/settings_local, because these are mode-agnostic
   * overrides rather than a persistent hand-off of control to Homey.
   *
   * assertPowerWithinRatedLimit() deliberately does NOT apply here. That check
   * compares against the battery's own rated power, but a grid setpoint is a
   * target at the meter, not battery output - a house pulling 18kW is a
   * perfectly legitimate grid target on a 12kW battery, and a negative setpoint
   * would pass the check vacuously anyway. The flow cards' own min/max bound
   * the value instead.
   *
   * @param {number} type - one of SCHEDULE_TYPE.GRID_*
   * @param {number} watts - setpoint at the grid connection point. For
   *   GRID_CHARGE_DISCHARGE: positive = import from grid, negative = export to
   *   grid, 0 = hold the connection at zero (self-consumption).
   * @param {{from?: string, to?: string}} [window] - optional time window. When
   *   given the setpoint is appended with `sched_add`; without it, `sched_set`
   *   replaces the current schedule so the change takes effect immediately.
   */
  async applyGridSetpoint(type, watts, window = {}) {
    const verb = (window.from || window.to) ? 'sched_add' : 'sched_set';
    const command = buildScheduleCommand(verb, type, { setpoint: watts, from: window.from, to: window.to });
    await this.sendBatteryCommand(command);
    this.log(`Applied grid setpoint ${watts}W (type ${type}) via '${command}'`);
  }

  onDiscoveryResult(discoveryResult) {
    // Return a truthy value here if the discovery result matches your device.
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    try {
      this.ip = discoveryResult.address; // Update IP address
      await this.setAvailable(); // Mark as available
      this.log(`Device is available at ${this.ip}`);
    } catch (error) {
      this.log('Error in onDiscoveryAvailable:', error.message);
    }
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    this.ip = discoveryResult.address; // Update IP address
    this.log(`Address changed to ${this.ip}`);
    await this.setAvailable();
  }


  async onDiscoveryLastSeenChanged(discoveryResult) {
    this.log(`Device last seen at ${discoveryResult.lastSeen}`);
    // Optionally handle reconnection logic here
  }
  
  
  /**
   * Called when the device is initialized
   */
  async onInit() {
    this.deviceName = this.getName();
    this.id = this.getData().id;
    this.ip = this.getData().ip;

    this.log(`Initializing battery device: ${this.deviceName} (id: ${this.id} at ${this.ip})`);

    // Register flow cards only once per app process to avoid duplicate listener warnings.
    // These are device-scoped cards, so each listener must act on `args.device` (the device
    // the flow actually targets) rather than `this` (whichever device happened to init first).
    if (!this.homey.app._homevoltFlowCardsRegistered) {
      this.homey.app._homevoltFlowCardsRegistered = true;

      // Register capability listener for battery status
      const cardConditionBatteryStatus = this.homey.flow.getConditionCard('battery_status');
      cardConditionBatteryStatus.registerRunListener(trackedRunListener('condition', 'battery_status', async (args, state) => {
        const device = args.device;
        try {
          const data = await device.homey.app.getStatus({ address: device.ip });
          const raw = data?.ems?.[0]?.op_state_str;
          const batteryStatus = typeof raw === 'string' ? raw.toLowerCase() : 'unknown';
          device.log(`Condition card executed. Card: ${args.battery_status}, Battery: ${batteryStatus}`);
          return batteryStatus === args.battery_status;
        } catch (error) {
          device.error('Error in battery_status condition:', error.message);
          return false;
        }
      }));

      // Flow action for clearing the schedule
      this.homey.flow.getActionCard('clear_schedule')
        .registerRunListener(trackedRunListener('action', 'clear_schedule', async (args) => {
          const device = args.device;
          try {
            await device.sendBatteryCommand('sched_clear');
            device.log('Schedule cleared successfully');
          } catch (err) {
            device.error('Failed to clear schedule:', err);
          }
        }));

      // Flow action card for planning to charge the battery
      this.homey.flow.getActionCard('charge_battery')
      .registerRunListener(trackedRunListener('action', 'charge_battery', async (args) => {
        const device = args.device;
        const { power, start_date, end_date, start_time, end_time } = args;
        device.assertPowerWithinRatedLimit(power);

        const command = buildScheduleCommand('sched_add', SCHEDULE_TYPE.INV_CHARGE, {
          setpoint: power,
          from: toScheduleTimestamp(start_date, start_time),
          to: toScheduleTimestamp(end_date, end_time),
        });
        try {
          await device.sendBatteryCommand(command);
          device.log(`Schedule set for charging: ${command}`);
        } catch (err) {
          device.error('Failed to set charge schedule:', err);
          throw new Error(err.message);
        }
      }));

      // Flow action card for planning to discharge the battery
      this.homey.flow.getActionCard('discharge_battery')
      .registerRunListener(trackedRunListener('action', 'discharge_battery', async (args) => {
        const device = args.device;
        const { power, start_date, end_date, start_time, end_time } = args;
        device.assertPowerWithinRatedLimit(power);

        const command = buildScheduleCommand('sched_add', SCHEDULE_TYPE.INV_DISCHARGE, {
          setpoint: power,
          from: toScheduleTimestamp(start_date, start_time),
          to: toScheduleTimestamp(end_date, end_time),
        });
        try {
          await device.sendBatteryCommand(command);
          device.log(`Schedule set for discharging: ${command}`);
        } catch (err) {
          device.error('Failed to set discharge schedule:', err);
          throw new Error(err.message);
        }
      }));

      // Grid-referenced actions (schedule types 3/4/5). Unlike the cards above,
      // the setpoint here is measured at the grid connection point rather than
      // at the inverter, so the battery does whatever it takes to hold the
      // *meter* at the requested value. The '..._now' cards replace the current
      // schedule (sched_set) for immediate effect; the 'plan_...' cards append a
      // window (sched_add) alongside whatever else is scheduled.
      //
      // Registered from a table since the six differ only in schedule type and
      // whether they carry a time window.
      const gridCards = [
        { id: 'grid_charge_now', type: SCHEDULE_TYPE.GRID_CHARGE, scheduled: false },
        { id: 'grid_discharge_now', type: SCHEDULE_TYPE.GRID_DISCHARGE, scheduled: false },
        { id: 'grid_setpoint_now', type: SCHEDULE_TYPE.GRID_CHARGE_DISCHARGE, scheduled: false },
        { id: 'plan_grid_charge', type: SCHEDULE_TYPE.GRID_CHARGE, scheduled: true },
        { id: 'plan_grid_discharge', type: SCHEDULE_TYPE.GRID_DISCHARGE, scheduled: true },
        { id: 'plan_grid_setpoint', type: SCHEDULE_TYPE.GRID_CHARGE_DISCHARGE, scheduled: true },
      ];

      for (const { id, type, scheduled } of gridCards) {
        this.homey.flow.getActionCard(id)
        .registerRunListener(trackedRunListener('action', id, async (args) => {
          const device = args.device;
          const window = scheduled
            ? {
              from: toScheduleTimestamp(args.start_date, args.start_time),
              to: toScheduleTimestamp(args.end_date, args.end_time),
            }
            : {};
          try {
            await device.applyGridSetpoint(type, args.power, window);
            return true;
          } catch (err) {
            device.error(`Failed to run '${id}':`, err);
            throw new Error(err.message);
          }
        }));
      }

      // Deprecated: superseded by Homey's native target_power for new Flows.
      // Deliberately calls applyTargetPower() directly rather than switching
      // target_power_mode to 'homey' first - that mode switch is a persistent
      // hand-off (per Homey's docs), and these cards are meant to be one-shot
      // overrides that don't silently and permanently pull the device out of
      // 'partner' mode. Hidden from new-Flow card pickers (see "deprecated":
      // true in driver.flow.compose.json).
      this.homey.flow.getActionCard('force_charge')
      .registerRunListener(trackedRunListener('action', 'force_charge', async (args) => {
        const device = args.device;
        const { power } = args;
        try {
          await device.applyTargetPower(power); // positive = charge
          device.log(`Force charging at ${power}W`);
          return true;
        } catch (err) {
          device.error('Failed to force charge:', err);
          throw new Error('Could not start force charging');
        }
      }));

      // Deprecated: see force_charge above.
      this.homey.flow.getActionCard('force_discharge')
      .registerRunListener(trackedRunListener('action', 'force_discharge', async (args) => {
        const device = args.device;
        const { power } = args;
        try {
          await device.applyTargetPower(-power); // discharge = negative target_power
          device.log(`Force discharging at ${power}W`);
          return true;
        } catch (err) {
          device.error('Failed to force discharge:', err);
          throw new Error('Could not start force discharging');
        }
      }));

      // Deprecated: kept working for existing Flows, hidden from new-Flow card
      // pickers (see "deprecated": true in driver.flow.compose.json). Superseded
      // by the Homey-native target_power_mode capability/cards.
      this.homey.flow.getActionCard('set_battery_control_mode')
      .registerRunListener(trackedRunListener('action', 'set_battery_control_mode', async (args) => {
        const device = args.device;
        const value = typeof args.mode === 'object' && args.mode.name ? args.mode.name : args.mode;
        device.log('Flow card: setting battery_control_mode to', value);
        // This legacy card only knows local/remote, which map 1:1 onto the
        // only two target_power_mode values there are: local -> homey, remote -> partner.
        const mode = value === 'local' ? 'homey' : 'partner';

        try {
          await device.setControlMode(mode);
          return true;
        } catch (err) {
          device.error('Failed to set battery control mode from flow:', err);
          throw new Error('Could not set battery control mode');
        }
      }))
      .registerArgumentAutocompleteListener('mode', async (query) => {
        const options = ['local', 'remote'].filter(m => m.includes(query.toLowerCase()));
        return options.map(m => ({ name: m }));
      });
    }

    // Backwards compatibility: devices paired before new capabilities were introduced
    await this.ensureCapability('battery_control_mode');
    await this.ensureCapability('target_power');
    await this.ensureCapability('target_power_mode');

    // Get initial values
    await this.fetchData().catch(this.error);
    await this.syncBatteryControlMode().catch(this.error);

    // Setup settings
    await this.initSettings();

    if (this.hasCapability('battery_control_mode')) {
      this.registerCapabilityListener('battery_control_mode', async (value) => {
        this.log('battery_control_mode changed to:', value);
        // Same legacy local/remote -> homey/partner mapping as the deprecated flow card.
        const mode = value === 'local' ? 'homey' : 'partner';
        // A capability listener only fires when something outside the app writes the value, so
        // this is genuinely a hand on a control - the poll loop updates values without it.
        track('Changed Capability', { capability: 'battery_control_mode', mode });
        try {
          await this.setControlMode(mode);
        } catch (err) {
          this.error('Failed to send battery control mode command:', err);
          throw new Error('Battery control mode command failed');
        }
      });
    }

    // Homey-native power control: target_power_mode picks who's in charge
    // (homey / partner cloud), target_power is the setpoint Homey pushes while
    // mode is 'homey'. Debounced since Homey may set both capabilities together
    // (e.g. switching to homey mode with an initial setpoint).
    if (this.hasCapability('target_power_mode') && this.hasCapability('target_power')) {
      this.registerMultipleCapabilityListener(['target_power_mode', 'target_power'], async (newValues) => {
        const { target_power_mode: mode, target_power: power } = newValues;

        if (mode !== undefined) {
          this.log(`target_power_mode changed to: ${mode} (settings_local -> ${this.isLocalControlMode(mode)})`);
          track('Changed Capability', { capability: 'target_power_mode', mode });
          await this.setControlMode(mode);
        }

        if (power !== undefined) {
          const effectiveMode = mode !== undefined ? mode : this.getCapabilityValue('target_power_mode');
          if (effectiveMode !== 'homey') {
            this.log(`Ignoring target_power=${power}W; target_power_mode is '${effectiveMode}', not 'homey'`);
            // Worth reporting: per Homey's docs their own target_power_set card switches mode to
            // 'homey' first, so a rejected write means something else is pushing setpoints at a
            // battery under partner control - a real integration problem, not a user mistake.
            track('Changed Capability', { capability: 'target_power', applied: false, mode: effectiveMode });
            return;
          }
          // Direction, not the value: a setpoint in watts is a detail of someone's tariff
          // optimisation and says more about their house than about this app.
          track('Changed Capability', {
            capability: 'target_power',
            applied: true,
            direction: power > 0 ? 'charge' : power < 0 ? 'discharge' : 'idle',
          });
          try {
            await this.applyTargetPower(power);
          } catch (err) {
            this.error('Failed to apply target_power:', err);
            throw new Error('Could not apply target power');
          }
        }
      }, 500);
    }

    // Get the initial polling interval from the app
    const appPollingInterval = this.homey.app.getPollingInterval();
    this.log(`Initial polling interval: ${appPollingInterval} seconds`);
    this.pollingInterval = appPollingInterval * 1000;

    // Start polling
    await this.setAvailable();
    this.startPolling();
  }

  /**
   * Poll the device at the configured interval
   */
  startPolling() {
    //this.log(`Starting polling every ${this.pollingInterval / 1000} seconds`);

    // Clear any existing timer
    if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
    }

    // Start a new polling timer
    this.pollingTimer = setInterval(async () => {
        try {
            await this.fetchData();
        } catch (error) {
            this.error('Error during polling:', error.message);
        }
    }, this.pollingInterval);
}

restartPolling(newInterval) {
    this.log(`Restarting polling with new interval: ${newInterval} seconds`);
    this.pollingInterval = newInterval * 1000; // Convert to milliseconds
    this.startPolling();
}

/**
 * Fetch data from the device's API
 */
async fetchData() {
  try {
    const data = await this.homey.app.getStatus({ address: this.ip });
    // getStatus resolves to null rather than rejecting once _fetchWithRetry has exhausted its
    // retries, so without this an unreachable battery surfaces as a TypeError on data.ems[0]
    // deep inside updateCapabilities rather than as the connection failure it actually is.
    if (!data || !Array.isArray(data.ems)) {
      throw new Error('No EMS data in response');
    }
    this.updateCapabilities(data);
    this.reportConnectionState(true);

  } catch (error) {
    this.log('Error fetching data:', error.message);
    this.reportConnectionState(false, error.message);
    await this.setUnavailable('Error fetching data');
  }
}

/**
 * Report a change in reachability, edge-triggered.
 *
 * Deliberately only fires on a *transition*. Polling runs every 5 seconds by default, so a
 * battery that is off for an hour would otherwise produce ~720 identical events - which would
 * both drown the project's event quota and turn one outage into what looks like an epidemic.
 */
reportConnectionState(reachable, reason) {
  if (this.connectionOk === reachable) return;
  const first = this.connectionOk === undefined;
  this.connectionOk = reachable;
  // Nothing to report the first time we succeed - that is just the device starting up normally.
  if (first && reachable) return;
  if (!reachable) {
    track('Lost Connection', { cause: 'poll_failed', reason: String(reason || 'unknown') });
  } else {
    track('Restored Connection', {});
  }
}

updateCapabilities(data) {

  // Refresh on every poll so it self-corrects if a pack is added/removed.
  // Only log on the initial detection or an actual change, not every poll.
  const newRatedPowerWatts = this.computeRatedPowerWatts(data);
  if (newRatedPowerWatts !== this.ratedPowerWatts) {
    this.log(`Detected rated power: ${newRatedPowerWatts}W (used as the max for charge/discharge flow actions)`);
    this.ratedPowerWatts = newRatedPowerWatts;
  }

  // Parse data into useful data points and update capabilities

  const batteryImportedKWh = data.ems[0]?.ems_data?.energy_consumed / 1000;     // Accumulated imported energy, scale to kWh
  const batteryExportedKWh = data.ems[0]?.ems_data?.energy_produced / 1000;    // Accumulated exported energy, scale to kWh
  const batteryChargePower = -data.ems[0]?.ems_data?.power;                     // Current charge power
  const batteryTargetPower = -data.ems[0]?.ems_control?.pwr_ref;                // Target power
  const batteryAvailableEnergykWh = data.ems[0]?.bms_data?.reduce(             // Loop through multiple packs to summarize vailable capacity in battery in kWh
    (total, pack) => total + (pack.energy_avail || 0), 0 ) / 1000;
  const batteryAvailableEnergyPct = data.ems[0]?.ems_data?.soc_avg / 100;      // Available capacity in battery in %
  const batteryTemperature = data.ems[0]?.ems_data?.sys_temp / 10;             // System temperature
  const batteryGridFrequency = data.ems[0]?.ems_data?.frequency / 1000;        // Grid frequency, scale to Hz
  const batteryStatus = data.ems[0]?.op_state_str;                             // Status of the battery

  // Update capabilities with the fetched data
  
  if (batteryTargetPower !== undefined && batteryTargetPower !== null) {
    this.setCapabilityValue('measure_power.target_power', batteryTargetPower).catch(this.error);
  }
  if (batteryChargePower !== undefined && batteryChargePower !== null) {
      this.setCapabilityValue('measure_power', batteryChargePower).catch(this.error);
  }
  if (batteryImportedKWh !== undefined && batteryImportedKWh !== null) {
      this.setCapabilityValue('meter_power.imported', batteryImportedKWh).catch(this.error);
  }
  if (batteryExportedKWh !== undefined && batteryExportedKWh !== null) {
      this.setCapabilityValue('meter_power.exported', batteryExportedKWh).catch(this.error);
  }
  if (batteryAvailableEnergykWh !== undefined && batteryAvailableEnergykWh !== null) {
      this.setCapabilityValue('meter_power.available', batteryAvailableEnergykWh).catch(this.error);
  }
  if (batteryAvailableEnergyPct !== undefined && batteryAvailableEnergyPct !== null) {
      this.setCapabilityValue('measure_battery', batteryAvailableEnergyPct).catch(this.error);
  }
  if (batteryTemperature !== undefined && batteryTemperature !== null) {
      this.setCapabilityValue('measure_temperature', batteryTemperature).catch(this.error);
  }
  if (batteryGridFrequency !== undefined && batteryGridFrequency !== null) {
      this.setCapabilityValue('measure_frequency', batteryGridFrequency).catch(this.error);
  }
  if (batteryStatus !== null) {
    this.reportOpState(batteryStatus);
    if (batteryStatus == 'charging') {
      this.setCapabilityValue('battery_status', this.homey.__("battery_status_charging")).catch(this.error);
    } else if (batteryStatus == 'discharging') {
      this.setCapabilityValue('battery_status', this.homey.__("battery_status_discharging")).catch(this.error);
    } else if (batteryStatus == 'idle') {
      this.setCapabilityValue('battery_status', this.homey.__("battery_status_idle")).catch(this.error);
    } else {
      this.setCapabilityValue('battery_status', this.homey.__("battery_status_unknown")).catch(this.error);
    }
  }

  this.setAvailable().catch(this.error); // Ensure the device remains available after updates
}

/**
 * Report the battery entering an operating state this app does not recognise.
 *
 * The firmware's `op_state_str` is a free-form string and docs/console-help.md does not enumerate
 * its values; the three handled below ('charging', 'discharging', 'idle') are simply the ones
 * seen on real units. Anything else falls through to the "Unknown" tile, which is exactly the
 * case worth knowing about - it is either a fault state or a value this app should be handling.
 * Reporting the raw string is the only way to find out which states actually occur in the field.
 *
 * Edge-triggered for the same reason as reportConnectionState(): at a 5-second poll a battery
 * sitting in one state would otherwise report it twelve times a minute.
 */
reportOpState(opState) {
  const state = typeof opState === 'string' ? opState.toLowerCase() : 'unknown';
  if (this.lastOpState === state) return;
  this.lastOpState = state;
  if (['charging', 'discharging', 'idle'].includes(state)) return;
  track('Raised Alarm', { code: state });
}

  /**
   * Called when the device is added. Exists only to report it: onInit also runs on every app
   * restart, so it cannot tell a new install from a reboot, and this can.
   */
  async onAdded() {
    track('Changed Device Set', { action: 'added', driver: 'homevolt-battery' });
  }

  /**
   * Called when the device is deleted
   */
  async onDeleted() {
    this.log('Device deleted, stopping polling');
    track('Changed Device Set', { action: 'removed', driver: 'homevolt-battery' });
    if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
    }
  }

  async initSettings() {
    try {
      // Fetch data safely
      const data = await this.homey.app.getStatus({ address: this.ip }) || {};
      const system = await this.homey.app.getSystem({ address: this.ip }) || {};

      // Aggregate values across multiple EMS entries AND battery packs
      const emsList = Array.isArray(data?.ems) ? data.ems : [];

      // Total number of battery packs across all EMS entries
      const totalBatteryPacks = emsList.reduce(
        (sum, ems) => sum + (Array.isArray(ems?.bms_info) ? ems.bms_info.length : 0),
        0
      );

      // Rated capacity is per pack (bms_info.rated_cap), so sum all packs
      const totalRatedCapacity = emsList.reduce((sum, ems) => {
        const packs = Array.isArray(ems?.bms_info) ? ems.bms_info : [];
        return sum + packs.reduce((s, p) => s + (p?.rated_cap || 0), 0);
      }, 0);

      // Available capacity is already aggregated per EMS entry (ems_data.avail_cap), so sum across EMS entries
      const totalAvailableCapacity = emsList.reduce((sum, ems) => sum + (ems?.ems_data?.avail_cap || 0), 0);

      // Rated power is per EMS (inverter/EMS), so sum across EMS entries
      const totalRatedPower = this.computeRatedPowerWatts(data);
      this.ratedPowerWatts = totalRatedPower;

      // Safeguard against missing properties
      const settings = {
        wifi_ssid: system?.wifi_status?.ssid || "No SSID found",
        wifi_ip: system?.wifi_status?.ip || "Unknown",
        battery_packs: `${totalBatteryPacks || 0}`,
        rated_capacity: `${(totalRatedCapacity || 0) / 1000} kWh`,
        available_capacity: `${(totalAvailableCapacity || 0) / 1000} kWh`,
        rated_power: `${(totalRatedPower || 0) / 1000} kW`
      };

      this.log('Init device settings with:', settings);

      // Apply settings safely
      await this.setSettings(settings).catch(err => this.error("Error applying settings:", err));

      // What this install *is*, as opposed to what it did - sent as anonymous user properties so
      // the cross-sectional questions ("of the 3-pack installs, how many run in partner mode?")
      // are a segmentation rather than an event count. Debounced inside reportInstallProfile(),
      // so several devices initialising at once collapse into one identify.
      //
      // Note what is NOT here: wifi_ssid and wifi_ip are read just above for the device settings
      // page, and neither has any business leaving the LAN.
      reportInstallProfile({
        batteryPacks: totalBatteryPacks || 0,
        ratedCapacityKwh: (totalRatedCapacity || 0) / 1000,
        ratedPowerW: totalRatedPower || 0,
        controlMode: this.hasCapability('target_power_mode')
          ? this.getCapabilityValue('target_power_mode')
          : undefined,
        ...this.homey.app.hostFacts(),
      });

    } catch (error) {
      this.error("Error initializing device settings:", error);
    }
  }

  async syncBatteryControlMode() {
    // If neither capability is present and couldn't be added, don't blow up device init
    if (!this.hasCapability('battery_control_mode') && !this.hasCapability('target_power_mode')) {
      this.log('syncBatteryControlMode: no control-mode capability present; skipping sync');
      return false;
    }
    // Try a few firmware variants; don't throw from here so device init never fails
    // 'param_dump' used to sit in the middle of this chain, but no firmware has
    // ever had that command - 'param_list' is the one that dumps key/value
    // pairs (see docs/console-help.md), and its output already matches the
    // "settings_local <true|false>" pattern below.
    const commands = [
      'param_get settings_local', // newest firmware
      'param_list',               // older firmware: dumps all key/value pairs
      'help'                      // last resort: might list current settings inline
    ];

    for (const cmd of commands) {
      try {
        const resText = await this.sendBatteryCommand(cmd);
        const text = String(resText || '').trim();

        // Common patterns:
        // 1) "settings_local true" / "settings_local false"
        // 2) Just "true" or "false" when using param_get
        // 3) A help/dump that contains the key somewhere in the output
        const kvMatch = text.match(/settings_local\s+(true|false)/i);
        if (kvMatch) {
          const isLocal = kvMatch[1].toLowerCase() === 'true';
          await this.applyControlModeCapabilities(isLocal ? 'homey' : 'partner');
          this.log(`Synced control mode using '${cmd}': ${isLocal ? 'local' : 'remote'}`);
          return true;
        }

        if (/^\s*true\s*$/im.test(text)) {
          await this.applyControlModeCapabilities('homey');
          this.log(`Synced control mode using '${cmd}': local`);
          return true;
        }
        if (/^\s*false\s*$/im.test(text)) {
          await this.applyControlModeCapabilities('partner');
          this.log(`Synced control mode using '${cmd}': remote`);
          return true;
        }

        // If 'help' returns something that clearly shows settings_local=true/false inline.
        // The 2026-08-11 firmware capture in docs/console-help.md contains no such line,
        // so this is purely a speculative fallback for firmware we haven't seen.
        if (cmd === 'help') {
          const helpMatch = text.match(/settings_local\s*=\s*(true|false)/i);
          if (helpMatch) {
            const isLocal = helpMatch[1].toLowerCase() === 'true';
            await this.applyControlModeCapabilities(isLocal ? 'homey' : 'partner');
            this.log(`Synced control mode by parsing help: ${isLocal ? 'local' : 'remote'}`);
            return true;
          }
        }

        // If we reach here for this cmd, continue to next variant
        this.log(`syncBatteryControlMode: '${cmd}' returned no parsable value.`);
      } catch (e) {
        // sendBatteryCommand throws for HTTP errors; swallow and try next variant
        this.log(`syncBatteryControlMode: '${cmd}' failed: ${e.message}`);
        continue;
      }
    }

    // Fallback: don't fail init; default to 'remote'/'partner' and continue
    this.log('syncBatteryControlMode: could not determine settings_local; defaulting to remote');
    await this.applyControlModeCapabilities('partner');
    return false;
  }

  async sendBatteryCommand(cmd) {
    const form = new FormData();
    form.append('cmd', cmd);
    const startedAt = Date.now();

    if (DEBUG) this.log(`[console] POST cmd='${cmd}'`);
    const res = await fetch(`http://${this.ip}/console.json`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    const resultText = await res.text();
    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      this.error(`[console] cmd='${cmd}' failed after ${elapsedMs}ms: HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}: ${resultText}`);
    }

    // Detect error in command output
    if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('invalid')) {
      this.error(`[console] cmd='${cmd}' device error after ${elapsedMs}ms: ${resultText}`);
      throw new Error(`Device responded with error: ${resultText}`);
    }

    if (DEBUG) this.log(`[console] cmd='${cmd}' ok after ${elapsedMs}ms`);
    return resultText;
  }
}

module.exports = HomevoltBatteryDevice;