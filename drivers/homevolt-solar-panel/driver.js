const Homey = require('homey');
const {
  SECRET_SETTING, SCHEME_STORE, parseAddressArgs, probeHub, pairedDeviceExtras,
} = require('../../lib/auth');
const { discoveredHubs } = require('../../lib/discovery');

class HomevoltSolarPanelDriver extends Homey.Driver {
  /**
   * Called during device pairing to list available solar panel sensors
   */
  async onPairListDevices() {
    this.log('Searching for solar panel sensors with mDNS...');

    // Both the http and https announcements; see lib/discovery.js.
    const discoveryResults = discoveredHubs(this.homey);

    this.log('Solar panel discovery results:', discoveryResults);

    const devices = discoveryResults.map(discoveryResult => ({
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

    // Read before creating, so a hub with sign-in on is caught here rather than pairing fine and
    // then sitting unavailable. A hub that cannot be reached at all is still added, as before.
    session.setHandler('add_discovered', async ({ device, secret: entered } = {}) => {
      const probe = await probeHub(this.homey, device.data.ip, entered);
      if (probe.needsSecret) return probe;
      return { device: { ...device, ...pairedDeviceExtras(probe) } };
    });

    session.setHandler('manual_pair', async (args) => {
      const { address, secret: entered } = parseAddressArgs(args);

      const probe = await probeHub(this.homey, address, entered);
      if (probe.needsSecret) return probe;
      const { data } = probe;
      if (!data || !Array.isArray(data.sensors)) {
        throw new Error(`Could not reach a Homevolt device at ${address}`);
      }

      const device = {
        name: 'Solar Sensor',
        data: {
          id: `${address}-solarpanel`,
          ip: address,
        },
      };
      return { device: { ...device, ...pairedDeviceExtras(probe) } };
    });
  }

  /**
   * Repair: lets the user re-enter the IP address of an already-paired
   * device without deleting and re-pairing it (e.g. after a DHCP change on a
   * subnet mDNS can't reach), and the device password or access token. See drivers/homevolt-solar-panel/pair/repair_ip.html.
   */
  async onRepair(session, device) {
    session.setHandler('get_ip', async () => device.ip);

    session.setHandler('repair_ip', async (args) => {
      const { address, secret: entered } = parseAddressArgs(args);

      // Repair is a deliberate retry, so whatever the hub refused before is tried again.
      this.homey.app.resetAuth(address);
      const probe = await probeHub(this.homey, address, entered, device.secret());
      if (probe.needsSecret) return probe;
      const { data, secret, scheme } = probe;
      if (!data || !Array.isArray(data.sensors)) {
        throw new Error(`Could not reach a Homevolt device at ${address}`);
      }

      // Persisted, not just set in memory: onInit re-reads the IP on every app restart, and
      // `data.ip` cannot be changed, so an in-memory-only update reverted to the pairing IP.
      await device.setStoreValue('ip', address);
      device.ip = address;
      await device.setStoreValue(SCHEME_STORE, scheme);
      device.log(`IP address updated via repair to ${address} (${scheme})`);

      if (secret !== device.secret()) {
        await device.setSettings({ [SECRET_SETTING]: secret });
        await this.homey.app.shareSecret(address, secret, device);
        device.log('Password/token updated via repair');
      }
      device.fetchData().catch(device.error);
      return { done: true };
    });
  }
}

module.exports = HomevoltSolarPanelDriver;
