const Homey = require('homey');

class HomevoltSensorDriver extends Homey.Driver {
  /**
   * Called during device pairing to list available sensors
   */
  async onPairListDevices() {
    this.log('Searching for sensors with mDNS...');

    // Retrieve discovery strategy
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    // Log discovery results
    this.log('Sensor discovery results:', discoveryResults);

    // Map discovery results to sensor devices
    const devices = Object.values(discoveryResults).flatMap(discoveryResult => {
      const ip = discoveryResult.address;

      // Data structure for "grid" and "solar" sensors
      return [
        {
          name: `Grid Sensor`,
          data: {
            id: `${discoveryResult.host}-grid`,
            type: 'grid',
            ip,
          },
        },
        {
          name: `Solar Sensor`,
          data: {
            id: `${discoveryResult.host}-solar`,
            type: 'solar',
            ip,
          },
        },
      ];
    });

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