const { Device } = require('homey');

class HomevoltSolarPanelDevice extends Device {
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
    this.log(`Initializing solar panel device: ${this.getName()}`);
    this.log(`[homevolt-solar-panel] Native driver, class '${this.getClass()}' declared in manifest - no runtime overrides needed`);

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

      // Robust matching: firmware payloads vary (`function`, `type`, sometimes slightly different names)
      const normalize = (v) => String(v || '').toLowerCase();
      const aliases = ['solar', 'pv', 'photovoltaic'];

      const match = (s) => {
        const candidates = [normalize(s.function), normalize(s.type), normalize(s.name)].filter(Boolean);
        return candidates.some(c => aliases.includes(c));
      };

      const sensorData = data.sensors.find(match);

      // Keep the device online with zeroed values when the feed omits solar (e.g. at night)
      const keepOnlineWithZeros = (src = {}) => {
        const zeroPhase = [{ amp: 0 }, { amp: 0 }, { amp: 0 }];
        this.updateCapabilities({
          total_power: 0,
          energy_imported: src.energy_imported ?? 0,
          energy_exported: src.energy_exported ?? 0,
          rssi: Number.isFinite(Number(src.rssi)) ? Number(src.rssi) : 0,
          phase: Array.isArray(src.phase) && src.phase.length ? src.phase : zeroPhase,
        });
        return true;
      };

      if (!sensorData) {
        const present = data.sensors
          .map(s => ({ function: s.function, type: s.type, name: s.name }))
          .slice(0, 20);
        this.log(`No match for solar sensor. Present sensors:`, present);
        keepOnlineWithZeros();
        await this.setAvailable();
        return;
      }

      // Only treat as stale if timestamp is explicitly 0 (some firmwares omit timestamp entirely)
      if (sensorData.available === false || sensorData.timestamp === 0) {
        keepOnlineWithZeros(sensorData);
        await this.setAvailable();
        return;
      }

      this.updateCapabilities(sensorData);
    } catch (error) {
      this.log('Error fetching sensor data:', error.message);
      await this.setUnavailable(`Error fetching data: ${error.message}`);
    }
  }

  updateCapabilities(sensorData) {
    const { total_power, energy_imported, energy_exported, rssi } = sensorData;

    const toNumberOrUndefined = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const totalPowerN = toNumberOrUndefined(total_power);
    const importedN = toNumberOrUndefined(energy_imported);
    const exportedN = toNumberOrUndefined(energy_exported);
    const rssiN = toNumberOrUndefined(rssi);

    const p = Array.isArray(sensorData.phase) ? sensorData.phase : [];
    const currentL1 = toNumberOrUndefined(p[0]?.amp);
    const currentL2 = toNumberOrUndefined(p[1]?.amp);
    const currentL3 = toNumberOrUndefined(p[2]?.amp);

    if (totalPowerN !== undefined) {
      this.setCapabilityValue('measure_power', totalPowerN).catch(this.error);
    }
    if (importedN !== undefined) {
      this.setCapabilityValue('meter_power.imported', importedN).catch(this.error);
    }
    if (exportedN !== undefined) {
      this.setCapabilityValue('meter_power.exported', exportedN).catch(this.error);
    }
    if (rssiN !== undefined) {
      this.setCapabilityValue('measure_signal_strength', rssiN).catch(this.error);
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
    this.log(`Solar panel device deleted: ${this.getName()}`);
    if (this.pollingTimer) clearInterval(this.pollingTimer);
  }
}

module.exports = HomevoltSolarPanelDevice;
