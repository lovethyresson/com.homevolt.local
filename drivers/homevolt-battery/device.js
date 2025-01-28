const { Device } = require('homey');
const fetch = require('node-fetch');

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
    this.fetchData().catch(this.error);

    // Setup settings
    this.initSettings();

    // Register capability listener for battery status
    const cardConditionBatteryStatus = this.homey.flow.getConditionCard('battery_status');
    cardConditionBatteryStatus.registerRunListener(async (args, state) => {
      try {
        // Fetch data using the app's getStatus function
        const data = await this.homey.app.getStatus({ address: this.ip });
    
        // Extract battery status from fetched data
        const batteryStatus = data.ems[0]?.op_state_str;
    
        // Log the values for debugging
        this.log(`Args state (selected by user): ${args.state}`);
        this.log(`Device battery status (from data): ${batteryStatus}`);
    
        // Compare user-selected state with actual battery status
        return batteryStatus === args.state;
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
  
    const batteryImporteKWh = data.ems[0]?.ems_data?.energy_consumed / 1000;     // Accumulated imported energy, scale to kWh
    const batteryExportedKWh = data.ems[0]?.ems_data?.energy_produced / 1000;    // Accumulated exported energy, scale to kWh
    const batteryChargePower = data.ems[0]?.ems_data?.power;                     // Current charge power
    const batteryTargetPower = data.ems[0]?.ems_control?.pwr_ref;                // Target power
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
  if (batteryImporteKWh !== undefined && batteryImporteKWh !== null) {
      this.setCapabilityValue('meter_power.imported', batteryImporteKWh).catch(this.error);
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
    // Example: Dynamically set the settings from your source JSON
    const data = await this.homey.app.getStatus({ address: this.ip });
    const system = await this.homey.app.getSystem({ address: this.ip });

    //this.log('Init dynamic device settings with params:', params);

    const settings = {
      wifi_ssid: system.wifi_status?.ssid || "No SSID found", 
      wifi_ip: system.wifi_status?.ip || "Unknown",          
      battery_packs: `${data.ems?.[0]?.bms_info?.length || 0}`,
      rated_capacity: `${data.ems?.[0]?.ems_info?.rated_capacity / 1000 || 0} kWh`,
      available_capacity: `${data.ems?.[0]?.ems_data?.avail_cap / 1000 || 0} kWh`,
      rated_power: `${data.ems?.[0]?.ems_info?.rated_power / 1000 || 0} kW`
    };

    this.log('Init static device settings with:', settings);

    // Apply settings to the Homey app
    this.setSettings(settings).catch(this.error);
  }
}

module.exports = HomevoltBatteryDevice;