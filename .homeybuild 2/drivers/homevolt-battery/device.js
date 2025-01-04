const { Device } = require('homey');

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

    this.log(`Device initialized: ${this.deviceName} (id: ${this.id} at ${this.ip})`);

    await this.setAvailable();
    this.startPolling();
  }

  /**
   * Poll the device at the configured interval
   */
  async startPolling() {
    this.log(`Starting polling every ${this.pollingInterval / 1000} seconds`);

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    this.pollingTimer = setInterval(async () => {
      await this.fetchData();
    }, this.pollingInterval);
  }

/**
 * Fetch data from the device's API
 */
async fetchData() {
  try {
    const response = await fetch(`http://${this.ip}/ems.json`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data = await response.json();
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
    const batteryAvailableEnergykWh = data.ems[0]?.bms_data?.[0]?.energy_avail;  // Available capacity in battery in kWh
    const batteryAvailableEnergyPct = data.ems[0]?.ems_data?.soc_avg / 100;      // Available capacity in battery in %
    const batteryTemperature = data.ems[0]?.ems_data?.sys_temp / 10;             // System temperature
    const batteryGridFrequency = data.ems[0]?.ems_data?.frequency / 1000;        // Grid frequency, scale to Hz


    // Update capabilities with the fetched data
    
    if (batteryTargetPower !== undefined && batteryTargetPower !== null) {
      this.setCapabilityValue('measure_target_power', batteryTargetPower).catch(this.error);
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
      this.setCapabilityValue('measure_energy_available', batteryAvailableEnergykWh).catch(this.error);
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