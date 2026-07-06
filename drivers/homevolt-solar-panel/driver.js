const Homey = require('homey');

class HomevoltSolarPanelDriver extends Homey.Driver {
  /**
   * Called during device pairing to list available solar panel sensors
   */
  async onPairListDevices() {
    this.log('Searching for solar panel sensors with mDNS...');

    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    this.log('Solar panel discovery results:', discoveryResults);

    const devices = Object.values(discoveryResults).map(discoveryResult => ({
      name: `Solar Sensor`,
      data: {
        id: `${discoveryResult.host}-solarpanel`,
        ip: discoveryResult.address,
      },
    }));

    this.log('Found solar panel sensors:', devices);
    return devices;
  }

  /**
   * Called when the driver is initialized
   */
  async onInit() {
    this.log('HomevoltSolarPanelDriver initialized');
  }
}

module.exports = HomevoltSolarPanelDriver;
