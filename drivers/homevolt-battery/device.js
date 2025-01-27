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
    this.pollingInterval = (this.getSetting('pollingInterval') || 5) * 1000;

    this.log(`Initializing battery device: ${this.deviceName} (id: ${this.id} at ${this.ip})`);

    // Get initial values
    this.fetchData().catch(this.error);

    // Register capability listener for battery status
    const cardConditionBatteryStatus = this.homey.flow.getConditionCard('battery_status');
    cardConditionBatteryStatus.registerRunListener(async (args, state) => {
      const data = await fetchData();
      //this.log(args);
      this.log(`Data: ${data}`);
      const batteryStatus = data.ems[0]?.op_state_str;
      //this.log(`Checking battery status: ${args.battery_status} vs ${batteryStatus}`);
      return batteryStatus === args.battery_status;
      }
    ); 

    await this.setAvailable();
    this.startPolling();
  }

  /**
   * Poll the device at the configured interval
   */
  async startPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    this.pollingTimer = setInterval(async () => {
      await this.fetchData();
    }, this.homey.app.pollingInterval * 1000);
    
  }

/**
 * Fetch data from the device's API
 */
async fetchData() {
  try {
    const data = await this.homey.app.getStatus({ address: this.ip });
    this.updateCapabilities(data);
    //return data;
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
   * Called when device settings are updated
   */
  async onSettings({ changedKeys, newSettings }) {
    this.log(`Settings updated: ${changedKeys}`);

    if (changedKeys.includes('pollingInterval')) {
      this.pollingInterval = newSettings.pollingInterval * 1000;
      this.startPolling();
    }
  }

  /**
   * Called when the device is deleted
   */
  async onDeleted() {
    this.log(`Device deleted: ${this.deviceName}`);
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }
  }
}

module.exports = HomevoltBatteryDevice;