const { Device } = require('homey');
const fetch = require('node-fetch');
const FormData = require('form-data');

class HomevoltBatteryDevice extends Device {

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

    // Get initial values
    await this.fetchData().catch(this.error);
    await this.syncBatteryControlMode().catch(this.error);

    // Setup settings
    await this.initSettings();

    this.registerCapabilityListener('battery_control_mode', async (value) => {
      this.log('battery_control_mode changed to:', value);
      const command = `param_set settings_local ${value === 'local' ? 'true' : 'false'}`;
      try {
        const resultSet = await this.sendBatteryCommand(command);
        //this.log(`Battery response (param_set): ${resultSet}`);
    
        const resultStore = await this.sendBatteryCommand('param_store');
        //this.log(`Battery response (param_store): ${resultStore}`);
    
      } catch (err) {
        this.error('Failed to send battery control mode command:', err);
        throw new Error('Battery control mode command failed');
      }
    });

    // Register capability listener for battery status
    const cardConditionBatteryStatus = this.homey.flow.getConditionCard('battery_status');
    cardConditionBatteryStatus.registerRunListener(async (args, state) => {
      try {
        // Fetch data using the app's getStatus function
        const data = await this.homey.app.getStatus({ address: this.ip });
    
        // Extract battery status from fetched data
        const batteryStatus = data.ems[0]?.op_state_str;
    
        // Log the values for debugging
        this.log(`Condition card executed. Card: ${args.battery_status}, Battery: ${batteryStatus}`);
            
        // Compare user-selected state with actual battery status
        return batteryStatus === args.battery_status;
      } catch (error) {
        this.error('Error in battery_status condition:', error.message);
        return false; // Fail safely
      }
    });
    

    // Get the initial polling interval from the app
    const appPollingInterval = this.homey.app.getPollingInterval();
    this.log(`Initial polling interval: ${appPollingInterval} seconds`);
    this.pollingInterval = appPollingInterval * 1000;


    // Start polling
    await this.setAvailable();
    this.startPolling();

    // Register flow action cards

    // Flow action for clearing the schedule
    this.homey.flow.getActionCard('clear_schedule')
      .registerRunListener(async () => {
        try {
          await this.sendBatteryCommand('sched_clear');
          this.log('Schedule cleared successfully');
        } catch (err) {
          this.error('Failed to clear schedule:', err);
        }
      });

    // Flow action card for charging the battery
    this.homey.flow.getActionCard('charge_battery')
    .registerRunListener(async (args) => {
      const { power, start_date, end_date, start_time, end_time } = args;
      function formatDate(dateString) {
        const [day, month, year] = dateString.split('-');
        return `${year}-${month}-${day}`;
      }
      const from = `${formatDate(start_date)}T${start_time}:00`;
      const to = `${formatDate(end_date)}T${end_time}:00`;

      const command = `sched_add 1 --cond_type=1 --setpoint=${power} --from=${from} --to=${to}`;
      try {
        await this.sendBatteryCommand(command);
        this.log(`Schedule set for charging: ${command}`);
      } catch (err) {
        this.error('Failed to set charge schedule:', err);
        throw new Error(err.message);
      }
    });

    // Flow action card for discharging the battery
    this.homey.flow.getActionCard('discharge_battery')
    .registerRunListener(async (args) => {
      const { power, start_date, end_date, start_time, end_time } = args;
      function formatDate(dateString) {
        const [day, month, year] = dateString.split('-');
        return `${year}-${month}-${day}`;
      }
      const from = `${formatDate(start_date)}T${start_time}:00`;
      const to = `${formatDate(end_date)}T${end_time}:00`;

      const command = `sched_add 2 --cond_type=1 --setpoint=${power} --from=${from} --to=${to}`;
      try {
        await this.sendBatteryCommand(command);
        this.log(`Schedule set for discharging: ${command}`);
      } catch (err) {
        this.error('Failed to set discharge schedule:', err);
        throw new Error(err.message);
      }
    });

    // Flow action card for setting battery control mode
    this.homey.flow.getActionCard('set_battery_control_mode')
    .registerRunListener(async (args) => {
      const value = typeof args.mode === 'object' && args.mode.name ? args.mode.name : args.mode;
      this.log('Flow card: setting battery_control_mode to', value);
  
      const command = `param_set settings_local ${value === 'local' ? 'true' : 'false'}`;
      try {
        await this.sendBatteryCommand(command);
        await this.sendBatteryCommand('param_store');
        await this.setCapabilityValue('battery_control_mode', value);
        return true;
      } catch (err) {
        this.error('Failed to set battery control mode from flow:', err);
        throw new Error('Could not set battery control mode');
      }
    })
    .registerArgumentAutocompleteListener('mode', async (query) => {
      const options = ['local', 'remote'].filter(m => m.includes(query.toLowerCase()));
      return options.map(m => ({ name: m })); // This is fine
    });
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
    this.updateCapabilities(data);

  } catch (error) {
    this.log('Error fetching data:', error.message);
    await this.setUnavailable('Error fetching data');
  }
}

updateCapabilities(data) {

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
   * Called when the device is deleted
   */
  async onDeleted() {
    this.log('Device deleted, stopping polling');
    if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
    }
  }

  async initSettings() {
    try {
      // Fetch data safely
      const data = await this.homey.app.getStatus({ address: this.ip }) || {};
      const system = await this.homey.app.getSystem({ address: this.ip }) || {};
  
      // Safeguard against missing properties
      const settings = {
        wifi_ssid: system?.wifi_status?.ssid || "No SSID found", 
        wifi_ip: system?.wifi_status?.ip || "Unknown",          
        battery_packs: `${data?.ems?.[0]?.bms_info?.length || 0}`,
        rated_capacity: `${(data?.ems?.[0]?.ems_info?.rated_capacity || 0) / 1000} kWh`,
        available_capacity: `${(data?.ems?.[0]?.ems_data?.avail_cap || 0) / 1000} kWh`,
        rated_power: `${(data?.ems?.[0]?.ems_info?.rated_power || 0) / 1000} kW`
      };
  
      this.log('Init device settings with:', settings);
  
      // Apply settings safely
      await this.setSettings(settings).catch(err => this.error("Error applying settings:", err));
  
    } catch (error) {
      this.error("Error initializing device settings:", error);
    }
  }

  async syncBatteryControlMode() {
    const formData = new URLSearchParams();
    formData.append('cmd', 'param_dump');

    const res = await fetch(`http://${this.ip}/console.json`, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const resultText = await res.text();
    const isLocal = resultText.includes('settings_local true');

    const mode = isLocal ? 'local' : 'remote';
    await this.setCapabilityValue('battery_control_mode', mode).catch(this.error);
    this.log(`Synced battery_control_mode to: ${mode}`);
  }

  async sendBatteryCommand(cmd) {
    const form = new FormData();
    form.append('cmd', cmd);
  
    const res = await fetch(`http://${this.ip}/console.json`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });
  
    const resultText = await res.text();
  
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${resultText}`);
    }
  
    // Detect error in command output
    if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('invalid')) {
      throw new Error(`Device responded with error: ${resultText}`);
    }
  
    return resultText;
  }
}

module.exports = HomevoltBatteryDevice;