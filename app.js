'use strict';

const Homey = require('homey');

module.exports = class HomevoltApp extends Homey.App {

  __statusPromises = {};

  async getStatus({ address }) {
    if(!this.__statusPromises[address]) {
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
    this.log('Homevolt has been initialized');

    // Get the polling interval from app settings
    const pollingInterval = this.homey.settings.get('pollingInterval') || 5; // Default to 5 seconds if not set
    this.log(`Polling interval is set to ${pollingInterval} seconds`);

    // Store or share the value across devices as needed
    this.pollingInterval = pollingInterval;
  }

};
