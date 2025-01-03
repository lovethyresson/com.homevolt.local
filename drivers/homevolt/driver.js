const Homey = require('homey');


class HomevoltDriver extends Homey.Driver {
  // This method is called when a user is adding a device
  // and the 'list_devices' view is called
  // Extend this method to add sensors as devices later
  async onPairListDevices() {
    this.log('Searching for devices with mDNS ...');

    const discoveryStrategy = this.getDiscoveryStrategy();

    const discoveryResults = discoveryStrategy.getDiscoveryResults();
  
    const devices = Object.values(discoveryResults).map(discoveryResult => {
      return {
        name: `Homevolt`,
        data: {
          id: (discoveryResult.host.match(/homevolt-([a-zA-Z0-9]+)\.local/) || [])[1],
          ip: discoveryResult.id,
        },
      };
    });

    this.log('Found devices:', devices);
    return devices;
  }

  // this method is called when the app is started and the Driver is inited
  async onInit() {
    this.log('HomevoltDriver initialized');
  }
}

module.exports = HomevoltDriver;