const { Device } = require('homey');
const fetch = require('node-fetch');

class HomevoltSensorDevice extends Device {
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
  

  async onInit() {
    this.log(`Initializing sensor device: ${this.getName()} (${this.getData().type})`);

    this.type = this.getData().type; // "grid" or "solar"
    this.ip = this.getData().ip; // IP address of the device

    // Get initial values
    this.fetchData().catch(this.error);

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
   * If app settings change, update polling interval and restart polling
   */
  restartPolling(newInterval) {
      this.log(`Restarting polling with new interval: ${newInterval} seconds`);
      this.pollingInterval = newInterval; 
      this.startPolling();
  }
  
  async fetchData() {
    try {
      const data = await this.homey.app.getStatus({ address: this.ip });
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