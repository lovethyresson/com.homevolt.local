'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
  CONSENT_SETTING, initAnalytics, refreshConsent, appVersion, track, reportInstallProfile,
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

  /**
   * Send the anonymous install profile: what this install *is*, as opposed to what it did.
   *
   * Lives on the app rather than on a driver, which is where com.nibe.local puts its equivalent.
   * That app has one driver hosting all six roles, so a driver knows the whole installation; here
   * the three drivers each know a third of it, and the profile has to be the same whichever
   * drivers happen to be paired. This used to be called from the battery device's initSettings(),
   * which meant an install with only a grid sensor paired sent no profile at all.
   *
   * Synchronous on purpose: it reads already-known state, never the network. `firmware` comes from
   * the latch below, which every driver's poll feeds. Debounced inside reportInstallProfile(), so
   * several devices initialising at once collapse into one identify - and since every call
   * assembles the same install-wide snapshot rather than a caller-scoped one, the last snapshot
   * inside the debounce window is the complete one.
   *
   * @param {object} [caller] - the device asking for the sync, if any. Counted explicitly because
   *   a device calling this from its own onInit may not be in driver.getDevices() yet, and a
   *   single-device install would otherwise report an empty role set.
   */
  syncInstallProfile(caller) {
    try {
      const devices = [];
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        devices.push(...driver.getDevices());
      }
      if (caller && !devices.includes(caller)) devices.push(caller);

      // A set, not a list: two batteries are still one `battery` role, and `roles` answers "which
      // parts does this install have?". Sorted so the same install always sends the same array.
      const roles = [...new Set(devices
        .filter(device => typeof device.analyticsRole === 'function')
        .map(device => device.analyticsRole()))].sort();

      // Battery-specific facts come from a battery device when there is one; duck-typed for the
      // same reason restartDevicePolling() is, so a fourth driver needs no change here. The first
      // such device wins: a battery device already sums packs and rated power across every EMS
      // entry its own hub reports, and two separate hubs in one home is not a shape this profile
      // tries to describe (nor one `control_mode` could describe, since each hub has its own).
      const source = devices.find(device => typeof device.analyticsInstallFacts === 'function');

      reportInstallProfile({
        roles,
        firmware: this.firmwareVersion,
        ...(source ? source.analyticsInstallFacts() : {}),
        ...this.hostFacts(),
      });
    } catch (error) {
      this.error('Could not collect the install profile', error);
    }
  }

  /**
   * Remember the firmware version seen in an ems.json payload, and resync the install profile when
   * it changes.
   *
   * `ems[0].ems_info.fw_version` ('v31.3-6-gbe336a' on the author's unit) is the EMS firmware, and
   * it is what decides which console commands and schedule parameters exist - the thing worth
   * knowing when a report says a card does not work. Verified against a real unit on 2026-08-17:
   * the same value appears in status.json as `ems_status.ems_info.fw_version`, so either endpoint
   * would do; ems.json is the one all three drivers already poll. Deliberately not used instead:
   * `ecu_version`, which is an empty string on that unit, and the ESP/EFR build ids under
   * status.json's `firmware` object, which are build hashes rather than a version. Sent raw, never
   * mapped to a marketing name - a wrong guess here is unfixable, one in Amplitude is reversible.
   *
   * Called from every poll of every driver, so it must stay edge-triggered: it only resyncs when
   * the string actually changes, i.e. on the first successful poll and on a firmware upgrade.
   */
  noteFirmwareVersion(data) {
    const version = data?.ems?.[0]?.ems_info?.fw_version;
    if (typeof version !== 'string' || !version) return;
    if (version === this.firmwareVersion) return;
    this.firmwareVersion = version;
    this.syncInstallProfile();
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
