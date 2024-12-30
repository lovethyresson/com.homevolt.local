const { Device } = require('homey');

class HomevoltDevice extends Device {
  /**
   * Called when the device is initialized
   */
  async onInit() {
    this.log(`Device initialized: ${this.getName()}`);

    // Retrieve stored settings
    this.ip = this.getData().id; // IP address provided during pairing
    this.pollingInterval = (this.getSetting('pollingInterval') || 5) * 1000; // Convert seconds to milliseconds

    // Start polling
    this.startPolling();
  }

  /**
   * Poll the device at the configured interval
   */
  async startPolling() {
    this.log(`Starting polling every ${this.pollingInterval / 1000} seconds`);

    // Clear any existing polling timer
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    // Set up polling
    this.pollingTimer = setInterval(async () => {
      await this.fetchData();
    }, this.pollingInterval);
  }

  /**
   * Fetch data from the device's API
   */
/**
 * Fetch data from the device's API
 */
async fetchData() {
  try {
    const response = await fetch(`http://${this.ip}/ems.json`);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();




    // Parse data into useful data points and update capabilities
    
    const batteryImporteKWh = data.ems[0]?.ems_data?.energy_consumed / 1000;     // Accumulated imported energy
    const batteryExportedKWh = data.ems[0]?.ems_data?.energy_produced / 1000;    // Accumulated exported energy
    const batteryChargePower = data.ems[0]?.ems_data?.power;                     // Current charge power
    const batteryTargetPower = data.ems[0]?.ems_control?.pwr_ref;                // Target power
    const batteryAvailableEnergykWh = data.ems[0]?.bms_data?.[0]?.energy_avail;  // Available capacity in battery in kWh
    const batteryAvailableEnergyPct = data.ems[0]?.ems_data?.soc_avg / 100;      // Available capacity in battery in %
    const batteryTemperature = data.ems[0]?.ems_data?.sys_temp / 10;             // System temperature
    const batteryGridFrequency = data.ems[0]?.ems_data?.frequency / 1000;        // Grid frequency
    
    
    // Update capabilities with the fetched data
    
    if (batteryTargetPower !== undefined && batteryTargetPower !== null) {
        this.setCapabilityValue('measure_target_power', batteryTargetPower);
    }
    if (batteryChargePower !== undefined && batteryChargePower !== null) {
        this.setCapabilityValue('measure_power', batteryChargePower);
    }
    if (batteryImporteKWh !== undefined && batteryImporteKWh !== null) {
        this.setCapabilityValue('meter_power.imported', batteryImporteKWh);
    }
    if (batteryExportedKWh !== undefined && batteryExportedKWh !== null) {
        this.setCapabilityValue('meter_power.exported', batteryExportedKWh);
    }
    if (batteryAvailableEnergykWh !== undefined && batteryAvailableEnergykWh !== null) {
        this.setCapabilityValue('measure_energy_available', batteryAvailableEnergykWh);
    }
    if (batteryAvailableEnergyPct !== undefined && batteryAvailableEnergyPct !== null) {
        this.setCapabilityValue('measure_battery', batteryAvailableEnergyPct);
    }
    if (batteryTemperature !== undefined && batteryTemperature !== null) {
        this.setCapabilityValue('measure_temperature', batteryTemperature);
    }
    if (batteryGridFrequency !== undefined && batteryGridFrequency !== null) {
        this.setCapabilityValue('measure_frequency', batteryGridFrequency);
    }

    // this.log('Rated: ', data.ems[0]?.aggregated?.ems_info?.rated_capacity);

  
    //this.log('Data updated:', data.ems[0]?.bms_data?.energy_avail);
  } catch (error) {
    this.log('Error fetching data:', error.message);
  }
}


  /**
   * Called when device settings are updated
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`Device settings updated:`, changedKeys);

    if (changedKeys.includes('pollingInterval')) {
      // Convert seconds to milliseconds
      this.pollingInterval = newSettings.pollingInterval * 1000;
      this.log(`Polling interval changed to ${this.pollingInterval / 1000} seconds`);

      // Restart polling with the new interval
      this.startPolling();
    }
  }

  /**
   * Called when the device is deleted
   */
  async onDeleted() {
    this.log(`Device deleted: ${this.getName()}`);

    // Clear the polling timer
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }
  }
}

module.exports = HomevoltDevice;
