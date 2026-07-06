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

  /**
   * Custom pairing: keeps the default mDNS list_devices behavior (see
   * onPairListDevices above), and additionally lets the user type in an IP
   * address directly - for setups where mDNS can't reach the device (e.g.
   * it's on a different subnet than Homey). See
   * drivers/homevolt-solar-panel/pair/list_devices.html for the front-end.
   */
  async onPair(session) {
    session.setHandler('list_devices', () => this.onPairListDevices());

    session.setHandler('manual_pair', async (ip) => {
      const address = String(ip || '').trim();
      if (!address) {
        throw new Error('Please enter an IP address');
      }

      const data = await this.homey.app.getStatus({ address });
      if (!data || !Array.isArray(data.sensors)) {
        throw new Error(`Could not reach a Homevolt device at ${address}`);
      }

      return {
        name: 'Solar Sensor',
        data: {
          id: `${address}-solarpanel`,
          ip: address,
        },
      };
    });
  }

  /**
   * Repair: lets the user re-enter the IP address of an already-paired
   * device without deleting and re-pairing it (e.g. after a DHCP change on a
   * subnet mDNS can't reach). See drivers/homevolt-solar-panel/pair/repair_ip.html.
   */
  async onRepair(session, device) {
    session.setHandler('get_ip', async () => device.ip);

    session.setHandler('repair_ip', async (ip) => {
      const address = String(ip || '').trim();
      if (!address) {
        throw new Error('Please enter an IP address');
      }

      const data = await this.homey.app.getStatus({ address });
      if (!data || !Array.isArray(data.sensors)) {
        throw new Error(`Could not reach a Homevolt device at ${address}`);
      }

      device.ip = address;
      device.log(`IP address updated via repair to ${address}`);
    });
  }
}

module.exports = HomevoltSolarPanelDriver;
