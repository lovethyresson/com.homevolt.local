'use strict';

const Homey = require('homey');

module.exports = class Homevolt extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Homevolt has been initialized');
  }

};
