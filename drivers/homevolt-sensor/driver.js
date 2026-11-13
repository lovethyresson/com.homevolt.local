const Homey = require('homey');
const {
  SECRET_SETTING, SCHEME_STORE, parseAddressArgs, probeHub, pairedDeviceExtras,
} = require('../../lib/auth');

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

  /**
   * Custom pairing: keeps the default mDNS list_devices behavior (see
   * onPairListDevices above), and additionally lets the user type in an IP
   * address directly - for setups where mDNS can't reach the device (e.g.
   * it's on a different subnet than Homey). See
   * drivers/homevolt-sensor/pair/list_devices.html for the front-end.
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
        name: 'Grid Sensor',
        data: {
          id: `${address}-grid`,
          type: 'grid',
          ip: address,
        },
      };
      return { device: { ...device, ...pairedDeviceExtras(probe) } };
    });
  }

  /**
   * Repair: lets the user re-enter the IP address of an already-paired
   * device without deleting and re-pairing it (e.g. after a DHCP change on a
   * subnet mDNS can't reach), and the device password or access token. See drivers/homevolt-sensor/pair/repair_ip.html.
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

module.exports = HomevoltSensorDriver;