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

      // Robust matching: firmware payloads vary (`function`, `type`, sometimes slightly different names)
      const normalize = (v) => String(v || '').toLowerCase();
      const want = normalize(this.type);

      const aliases = {
        grid: ['grid', 'grid_pulse', 'gridpulse'],
        solar: ['solar', 'pv', 'photovoltaic'],
        battery: ['battery', 'batt'],
        load: ['load', 'consumption', 'house'],
      };

      const match = (s) => {
        const f = normalize(s.function);
        const t = normalize(s.type);
        const n = normalize(s.name);
        const candidates = [f, t, n].filter(Boolean);
        const accepted = aliases[want] || [want];
        return candidates.some(c => accepted.includes(c));
      };

      const sensorData = data.sensors.find(match);

      // Helper to keep solar online with zeros
      const keepSolarOnline = (src = {}) => {
        const zeroPhase = [{ amp: 0 }, { amp: 0 }, { amp: 0 }];
        const fallback = {
          total_power: 0,
          energy_imported: src.energy_imported ?? 0,
          energy_exported: src.energy_exported ?? 0,
          rssi: Number.isFinite(Number(src.rssi)) ? Number(src.rssi) : 0,
          phase: Array.isArray(src.phase) && src.phase.length ? src.phase : zeroPhase,
        };
        this.updateCapabilities(fallback);
        return true;
      };

      // If sensor not found
      if (!sensorData) {
        const present = data.sensors
          .map(s => ({ function: s.function, type: s.type, name: s.name }))
          .slice(0, 20);
        this.log(`No match for sensor type '${this.type}'. Present sensors:`, present);

        if (this.type === 'solar') {
          // Keep solar device online even when the feed omits it (e.g., night)
          keepSolarOnline();
          await this.setAvailable();
          return;
        }
        await this.setUnavailable(`No '${this.type}' sensor in payload`);
        return;
      }

      // Only treat as stale if timestamp is explicitly 0 (some firmwares omit timestamp entirely)
      const isStaleSolar = this.type === 'solar' && sensorData.timestamp === 0;
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
      await this.setUnavailable(`Error fetching data: ${error.message}`);
    }
  }

  updateCapabilities(sensorData) {
    // Safely extract fields
    const { total_power, energy_imported, energy_exported, rssi } = sensorData;

    const toNumberOrUndefined = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const totalPowerN = toNumberOrUndefined(total_power);
    const importedN = toNumberOrUndefined(energy_imported);
    const exportedN = toNumberOrUndefined(energy_exported);
    const rssiN = toNumberOrUndefined(rssi);

    // Phase array may be missing/short
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
    this.log(`Sensor device deleted: ${this.getName()}`);
    if (this.pollingTimer) clearInterval(this.pollingTimer);
  }
}

module.exports = HomevoltSensorDevice;