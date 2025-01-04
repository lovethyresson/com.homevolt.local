const { Device } = require('homey');

class HomevoltSensorDevice extends Device {
  async onInit() {
    this.log(`Initializing sensor device: ${this.getName()} (${this.getData().type})`);

    this.type = this.getData().type; // "grid" or "solar"
    this.ip = this.getData().ip; // IP address of the device

    // Get initial values
    this.fetchData().catch(this.error);

    // Start polling for sensor data
    this.startPolling();
  }

  async startPolling() {
    this.pollingInterval = (this.getSetting('pollingInterval') || 5) * 1000;

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    this.pollingTimer = setInterval(async () => {
      await this.fetchData();
    }, this.pollingInterval);
  }

  async fetchData() {
    try {
      const response = await fetch(`http://${this.ip}/ems.json`);
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();
      const sensorData = data.sensors.find(sensor => sensor.type === this.type);

      if (sensorData) {
        this.updateCapabilities(sensorData);
      }
    } catch (error) {
      this.log('Error fetching sensor data:', error.message);
      await this.setUnavailable('Error fetching data');
    }
  }

  updateCapabilities(sensorData) {
    //this.log(`Updating capabilities for ${this.type} sensor`);

    const totalPower = sensorData.total_power;
    const energyImported = sensorData.energy_imported;
    const energyExported = sensorData.energy_exported;
    const rssi = sensorData.rssi;
    const currentL1 = sensorData.phase[0].amp; // Amp for phase L1
    const currentL2 = sensorData.phase[1].amp; // Amp for phase L2
    const currentL3 = sensorData.phase[2].amp; // Amp for phase L3


    if (totalPower !== undefined) {
      this.setCapabilityValue('measure_power', totalPower).catch(this.error);
    }
    if (energyImported !== undefined) {
      this.setCapabilityValue('meter_power.imported', energyImported).catch(this.error);
    }
    if (energyExported !== undefined) {
      this.setCapabilityValue('meter_power.exported', energyExported).catch(this.error);
    }
    if (rssi !== undefined) {
      this.setCapabilityValue('measure_signal_strength', rssi).catch(this.error);
    }
    if (currentL1 !== undefined) {
      this.setCapabilityValue('measure_power.currentL1', currentL1).catch(this.error);
    }
    if (currentL2 !== undefined) {
      this.setCapabilityValue('measure_power.currentL2', currentL2).catch(this.error);
    }
    if (currentL3 !== undefined) {
      this.setCapabilityValue('measure_power.currentL3', currentL3).catch(this.error);
    }

    this.setAvailable().catch(this.error); // Ensure the device remains available after updates
  }

  async onDeleted() {
    this.log(`Sensor device deleted: ${this.getName()}`);
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }
  }
}

module.exports = HomevoltSensorDevice;