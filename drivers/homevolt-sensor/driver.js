const Homey = require('homey');

class HomevoltSensorDriver extends Homey.Driver {
  /**
   * Called during device pairing to list available sensors.
   * Solar panel sensors now pair through the dedicated homevolt-solar-panel
   * driver; this driver only pairs new Grid Sensor devices. Existing
   * already-paired Solar Sensor devices under this driver keep working via
   * the legacy compatibility path in device.js.
   */
  async onPairListDevices() {
    this.log('Searching for sensors with mDNS...');

    // Retrieve discovery strategy
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    // Log discovery results
    this.log('Sensor discovery results:', discoveryResults);

    // Map discovery results to grid sensor devices
    const devices = Object.values(discoveryResults).map(discoveryResult => ({
      name: `Grid Sensor`,
      data: {
        id: `${discoveryResult.host}-grid`,
        type: 'grid',
        ip: discoveryResult.address,
      },
    }));

    this.log('Found sensors:', devices);
    return devices;
  }

  /**
   * Called when the driver is initialized
   */
  async onInit() {
    this.log('HomevoltSensorDriver initialized');
  }
}

module.exports = HomevoltSensorDriver;