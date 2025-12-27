const { Device } = require('homey');
const fetch = require('node-fetch');

class HomevoltSensorDevice extends Device {
  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    try {
      this.ip = discoveryResult.address;
      await this.setAvailable();
      this.log(`Device is available at ${this.ip}`);
    } catch (error) {
      this.log('Error in onDiscoveryAvailable:', error.message);
    }
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    this.ip = discoveryResult.address;
    this.log(`Address changed to ${this.ip}`);
    await this.setAvailable();
  }

  async onDiscoveryLastSeenChanged(discoveryResult) {
    this.log(`Device last seen at ${discoveryResult.lastSeen}`);
  }

  async onInit() {
    this.log(`Initializing sensor device: ${this.getName()} (${this.getData().type})`);

    this.type = this.getData().type; // "grid" | "solar" | "battery" | "load"
    this.ip = this.getData().ip;

    // Initial fetch (non-blocking)
    this.fetchData().catch(this.error);

    // Polling interval (seconds -> ms)
    const appPollingInterval = this.homey.app.getPollingInterval();
    this.log(`Initial polling interval: ${appPollingInterval} seconds`);
    this.pollingInterval = appPollingInterval * 1000;

    await this.setAvailable();
    this.startPolling();
  }

  startPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = setInterval(async () => {
      try {
        await this.fetchData();
      } catch (error) {
        this.error('Error during polling:', error.message);
      }
    }, this.pollingInterval);
  }

  // Keep only ONE restartPolling; accept seconds and convert to ms
  restartPolling(newIntervalSeconds) {
    this.log(`Restarting polling with new interval: ${newIntervalSeconds} seconds`);
    this.pollingInterval = newIntervalSeconds * 1000;
    this.startPolling();
  }

  async fetchData() {
    try {
      const data = await this.homey.app.getStatus({ address: this.ip });

      if (!data || !Array.isArray(data.sensors)) {
        throw new Error('Missing sensors array');
      }

      // NEW: match on `function`, not `type`
      const sensorData = data.sensors.find(s => s.function === this.type);

      // Helper to keep solar online with zeros
      const keepSolarOnline = (src = {}) => {
        const zeroPhase = [{ amp: 0 }, { amp: 0 }, { amp: 0 }];
        const fallback = {
          total_power: 0,
          energy_imported: src.energy_imported ?? 0,
          energy_exported: src.energy_exported ?? 0,
          rssi: typeof src.rssi === 'number' ? src.rssi : 0,
          phase: Array.isArray(src.phase) && src.phase.length ? src.phase : zeroPhase,
        };
        this.updateCapabilities(fallback);
        return true;
      };

      // If sensor not found
      if (!sensorData) {
        if (this.type === 'solar') {
          // Keep solar device online even when the feed omits it (e.g., night)
          keepSolarOnline();
          await this.setAvailable();
          return;
        }
        await this.setUnavailable(`No '${this.type}' sensor in payload`);
        return;
      }

      // If sensor is present but marked unavailable or stale, keep solar online
      const isStaleSolar = this.type === 'solar' && (!sensorData.timestamp || sensorData.timestamp === 0);
      if (sensorData.available === false || isStaleSolar) {
        if (this.type === 'solar') {
          keepSolarOnline(sensorData);
          await this.setAvailable();
          return;
        }
        await this.setUnavailable(`'${this.type}' sensor unavailable`);
        return;
      }

      // Normal path
      this.updateCapabilities(sensorData);
    } catch (error) {
      this.log('Error fetching sensor data:', error.message);
      await this.setUnavailable('Error fetching data');
    }
  }

  updateCapabilities(sensorData) {
    // Safely extract fields
    const { total_power, energy_imported, energy_exported, rssi } = sensorData;

    // Phase array may be missing/short
    const p = Array.isArray(sensorData.phase) ? sensorData.phase : [];
    const currentL1 = p[0]?.amp;
    const currentL2 = p[1]?.amp;
    const currentL3 = p[2]?.amp;

    if (total_power !== undefined) {
      this.setCapabilityValue('measure_power', total_power).catch(this.error);
    }
    if (energy_imported !== undefined) {
      this.setCapabilityValue('meter_power.imported', energy_imported).catch(this.error);
    }
    if (energy_exported !== undefined) {
      this.setCapabilityValue('meter_power.exported', energy_exported).catch(this.error);
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

    this.setAvailable().catch(this.error);
  }

  async onDeleted() {
    this.log(`Sensor device deleted: ${this.getName()}`);
    if (this.pollingTimer) clearInterval(this.pollingTimer);
  }
}

module.exports = HomevoltSensorDevice;