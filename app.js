'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
  CONSENT_SETTING, initAnalytics, refreshConsent, appVersion, track,
} = require('./lib/analytics');

// Set by Homey only for `homey app run` (dev) sessions, not on installed/published apps.
const DEBUG = process.env.DEBUG === '1';

module.exports = class HomevoltApp extends Homey.App {

  __statusPromises = {};
  __paramPromises = {};

  async getStatus({ address }) {
    if (!this.__statusPromises[address]) {
      this.__statusPromises[address] = Promise.resolve().then(async () => {
        return this._fetchWithRetry(`http://${address}/ems.json`);
      });
  
      this.__statusPromises[address]
        .then(() => {
          // Invalidate cache after polling interval
          setTimeout(() => {
            delete this.__statusPromises[address];
          }, this.getPollingInterval() * 1000);
        })
        .catch(err => {
          this.error(`Failed to fetch status: ${err.message}`);
        });
    }
  
    return this.__statusPromises[address];
  }
  
  async getSystem({ address }) {
    if (!this.__paramPromises[address]) {
      this.__paramPromises[address] = Promise.resolve().then(async () => {
        return this._fetchWithRetry(`http://${address}/status.json`);
      });
    }
  
    return this.__paramPromises[address]; 
  }
  
  /**
   * Fetch data with retries and better error handling
   */
  async _fetchWithRetry(url, retries = 3, timeoutMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        if (DEBUG) this.log(`[fetch] GET ${url} (attempt ${attempt}/${retries})`);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const text = await res.text(); // Get raw text first
        if (!text.trim()) {
          throw new Error(`Empty response from ${url}`);
        }

        try {
          const parsed = JSON.parse(text); // Safely parse JSON
          if (DEBUG) this.log(`[fetch] GET ${url} ok after ${Date.now() - startedAt}ms`);
          return parsed;
        } catch (jsonError) {
          throw new Error(`Invalid JSON from ${url}: ${jsonError.message}`);
        }

      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        if (attempt < retries) {
          this.log(`Retrying (${attempt}/${retries}) due to error after ${elapsedMs}ms: ${error.message}`);
          await new Promise(res => setTimeout(res, 1000)); // Wait before retry
        } else {
          this.error(`Failed to fetch ${url} after ${retries} attempts (last failure after ${elapsedMs}ms): ${error.message}`);
          return null; // Return `null` instead of throwing to avoid unhandled rejections
        }
      }
    }
  }


  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Homevolt App initialized.');

    // Anonymous analytics, off unless the user ticked the box. Without consent this touches
    // nothing: no SDK init, no anonymous id minted, nothing on the wire. See lib/analytics.js.
    initAnalytics(this.homey, this.log.bind(this), this.error.bind(this));
    track('Started App', { app_version: appVersion() });

    // Get the initial polling interval
    const pollingInterval = this.getPollingInterval();
    this.log(`Initial polling interval: ${pollingInterval} seconds`);

    // Listen for changes to the polling interval setting
    this.homey.settings.on('set', async (key) => {
      if (key === 'pollingInterval') {
        const newInterval = this.getPollingInterval();
        this.log(`Polling interval updated to ${newInterval} seconds`);

        // Notify all devices to restart polling
        await this.restartDevicePolling(newInterval);
      }

      // The settings page writes this key directly, so consent flipped there is honored on the
      // next event rather than at the next app start.
      if (key === CONSENT_SETTING) {
        refreshConsent(this.homey);
      }
    });
  }

  /**
   * The hub this is all running on, for the anonymous install profile. Sent as the SDK reports it
   * rather than mapped to a product name: `platform` + `platformVersion` together identify the
   * product, but that mapping is Athom's to change and would rot here.
   *
   * Timezone is the country signal - 'Europe/Stockholm' resolves to a country for every zone that
   * matters, without embedding an IANA->ISO table that goes stale. Language and units are locale,
   * not location: plenty of Swedish users run Homey in English.
   */
  hostFacts() {
    try {
      return {
        homeyVersion: this.homey.version,
        homeyPlatform: this.homey.platform ?? 'local',
        homeyPlatformVersion: this.homey.platformVersion ?? 1,
        timezone: this.homey.clock.getTimezone(),
        language: this.homey.i18n.getLanguage(),
        units: this.homey.i18n.getUnits(),
      };
    } catch (error) {
      this.error('Could not read host facts for the install profile', error);
      return {};
    }
  }

  getPollingInterval() {
    const defaultPollingInterval = 5; // Default value in seconds
    const pollingInterval = this.homey.settings.get('pollingInterval');
    if (!pollingInterval) {
      return defaultPollingInterval;
    }
    const parsedInterval = parseInt(pollingInterval, 10);
    if (isNaN(parsedInterval) || parsedInterval < 1 || parsedInterval > 60) {
      this.log('Invalid polling interval, using default.');
      return defaultPollingInterval;
    }
    return parsedInterval;
  }

  async restartDevicePolling(newInterval) {
    this.log('Restarting polling for all devices...');

    try {
        // Iterate through all drivers
        const drivers = this.homey.drivers.getDrivers();
        for (const driver of Object.values(drivers)) {
            // Get devices managed by this driver
            const devices = driver.getDevices();
            for (const device of devices) {
                if (typeof device.restartPolling === 'function') {
                    this.log(`Restarting polling for device: ${device.getName()}`);
                    device.restartPolling(newInterval);
                } else {
                    this.log(`Device ${device.getName()} does not implement restartPolling.`);
                }
            }
        }
    } catch (error) {
        this.error('Error while restarting polling for devices:', error.message);
    }
  }
};
