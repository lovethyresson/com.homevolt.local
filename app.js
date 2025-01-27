'use strict';

const Homey = require('homey');

module.exports = class HomevoltApp extends Homey.App {

  __statusPromises = {};

  async getStatus({ address }) {
    if (!this.__statusPromises[address]) {
      this.__statusPromises[address] = Promise.resolve().then(async () => {
        const res = await fetch(`http://${address}/ems.json`);
        const data = await res.json();
        return data;
      });

      this.__statusPromises[address]
        .then(() => {
          // Invalidate cache as per pollinginterval
          setTimeout(() => {
            delete this.__statusPromises[address];
          }, this.pollingInterval * 1000);
        })
        .catch(err => {
          this.error(err);
        });
    }

    return this.__statusPromises[address];
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Homevolt App initialized.');

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
    });
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
