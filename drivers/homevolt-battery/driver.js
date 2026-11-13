const Homey = require('homey');
const { track, setAnalyticsConsent, analyticsConsent } = require('../../lib/analytics');
const {
  SECRET_SETTING, SCHEME_STORE, parseAddressArgs, probeHub, pairedDeviceExtras,
} = require('../../lib/auth');
const { discoveredHubs } = require('../../lib/discovery');


class HomevoltBatteryDriver extends Homey.Driver {
  // This method is called when a user is adding a device
  // and the 'list_devices' view is called
  // Extend this method to add sensors as devices later
  async onPairListDevices() {
    this.log('Searching for devices with mDNS ...');

    // Both the http and https announcements; see lib/discovery.js.
    const discoveryResults = discoveredHubs(this.homey);
  
    // Log discovery results
    this.log('Battery discovery results:', discoveryResults);

    
    // id retrieval is a bit messy but a workaround until the ID is provided isolated in the discovery result
    const devices = discoveryResults.map(discoveryResult => {
      return {
        name: `Homevolt`,
        data: {
          id: discoveryResult.host,
          ip: discoveryResult.address,
        },
      };
    });

    this.log('Found battery:', devices);
    // The highest-value event in the set: mDNS discovery is the one part of this app that cannot
    // be tested against every network it will meet, and `found_nothing` is the only signal that
    // it silently failed to see a battery that was there.
    track('Completed Detection', {
      mode: 'pair',
      method: 'mdns',
      found: devices.length,
      found_nothing: devices.length === 0,
    });
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

    // The consent checkbox on the pairing screen. Reads back the stored answer so the box shows
    // ticked for someone who already agreed on an earlier pairing.
    session.setHandler('get_analytics_consent', async () => analyticsConsent(this.homey));
    session.setHandler('set_analytics_consent', async (consent) => {
      setAnalyticsConsent(this.homey, consent === true);
      return true;
    });

    // A device picked from the mDNS list. It used to be created without contacting it; now it is
    // read first, because a unit with sign-in on would otherwise pair fine and then sit
    // unavailable. A unit that cannot be reached at all is still added, as before.
    session.setHandler('add_discovered', async ({ device, secret: entered } = {}) => {
      const probe = await probeHub(this.homey, device.data.ip, entered);
      if (probe.needsSecret) return probe;
      return { device: { ...device, ...pairedDeviceExtras(probe) } };
    });

    session.setHandler('manual_pair', async (args) => {
      const { address, secret: entered } = parseAddressArgs(args);

      // Manual entry means mDNS did not reach the battery - the fact that someone had to fall
      // back to typing an address is itself the finding, so it is reported either way. Except
      // when it asks for a password: the battery *was* found, and the retry with the password is
      // what gets reported.
      const probe = await probeHub(this.homey, address, entered);
      if (probe.needsSecret) return probe;
      const { data } = probe;
      if (!data || !Array.isArray(data.ems)) {
        track('Completed Detection', {
          mode: 'pair', method: 'manual', found: 0, found_nothing: true,
        });
        throw new Error(`Could not reach a Homevolt battery at ${address}`);
      }
      track('Completed Detection', {
        mode: 'pair', method: 'manual', found: 1, found_nothing: false,
      });

      const device = {
        name: 'Homevolt',
        data: {
          id: address,
          ip: address,
        },
      };
      return { device: { ...device, ...pairedDeviceExtras(probe) } };
    });
  }

  /**
   * Repair: lets the user re-enter the IP address of an already-paired device without deleting
   * and re-pairing it (e.g. after a DHCP change on a subnet mDNS can't reach), and the device
   * password or access token. See drivers/homevolt-battery/repair/repair_ip.html.
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
      if (!data || !Array.isArray(data.ems)) {
        track('Completed Detection', {
          mode: 'repair', method: 'manual', found: 0, found_nothing: true,
        });
        throw new Error(`Could not reach a Homevolt battery at ${address}`);
      }
      track('Completed Detection', {
        mode: 'repair', method: 'manual', found: 1, found_nothing: false,
      });

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

module.exports = HomevoltBatteryDriver;