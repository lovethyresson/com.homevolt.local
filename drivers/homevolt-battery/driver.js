const Homey = require('homey');


class HomevoltBatteryDriver extends Homey.Driver {
  // This method is called when a user is adding a device
  // and the 'list_devices' view is called
  // Extend this method to add sensors as devices later
  async onPairListDevices() {
    this.log('Searching for devices with mDNS ...');

    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();
  
    // Log discovery results
    this.log('Battery discovery results:', discoveryResults);

    
    // id retrieval is a bit messy but a workaround until the ID is provided isolated in the discovery result
    const devices = Object.values(discoveryResults).map(discoveryResult => {
      return {
        name: `Homevolt`,
        data: {
          id: discoveryResult.host,
          ip: discoveryResult.address,
        },
      };
    });

    this.log('Found battery:', devices);
    return devices;
  }

  // this method is called when the app is started and the Driver is inited
  async onInit() {
    this.log('HomevoltBatteryDriver initialized');
  }

  /**
   * Custom pairing: keeps the default mDNS list_devices behavior (see
   * onPairListDevices above), and additionally lets the user type in an IP
   * address directly - for setups where mDNS can't reach the battery (e.g.
   * it's on a different subnet than Homey). See
   * drivers/homevolt-battery/pair/list_devices.html for the front-end.
   */
  async onPair(session) {
    session.setHandler('list_devices', () => this.onPairListDevices());

    session.setHandler('manual_pair', async (ip) => {
      const address = String(ip || '').trim();
      if (!address) {
        throw new Error('Please enter an IP address');
      }

      const data = await this.homey.app.getStatus({ address });
      if (!data || !Array.isArray(data.ems)) {
        throw new Error(`Could not reach a Homevolt battery at ${address}`);
      }

      return {
        name: 'Homevolt',
        data: {
          id: address,
          ip: address,
        },
      };
    });
  }

  /**
   * Repair: lets the user re-enter the IP address of an already-paired
   * device without deleting and re-pairing it (e.g. after a DHCP change on a
   * subnet mDNS can't reach). See drivers/homevolt-battery/pair/repair_ip.html.
   */
  async onRepair(session, device) {
    session.setHandler('get_ip', async () => device.ip);

    session.setHandler('repair_ip', async (ip) => {
      const address = String(ip || '').trim();
      if (!address) {
        throw new Error('Please enter an IP address');
      }

      const data = await this.homey.app.getStatus({ address });
      if (!data || !Array.isArray(data.ems)) {
        throw new Error(`Could not reach a Homevolt battery at ${address}`);
      }

      device.ip = address;
      device.log(`IP address updated via repair to ${address}`);
    });
  }
}

module.exports = HomevoltBatteryDriver;