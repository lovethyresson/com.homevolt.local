# Homevolt

This app adds support for connecting your Homevolt battery to Homey. 
Monitor your charge level, charge/discharge pattern and even grid frequency from the Homey app.


## GETTING STARTED
1. Ensure the local web server is enabled, or create an access token in the Homevolt's web interface (see SIGN-IN below)
2. Install the Homevolt for Homey app
3. Add your Homevolt battery and sensors
4. Make sure you configure your sensors as per your requirement. If the Grid sensor is your only incoming measurement, feel free to use that. If not, disable the contribution to home energy in the advanced settings.

---


## CONSIDERATIONS & LIMITATIONS
- This app is using the local webserver to poll data. 
- This is an unsanctioned, non supported API and may break at any point in time.
- This app is not affiliated with Homevolt/Tibber/Polarium.
- Scheduling is supported through Flow cards (charge/discharge now or over a planned time window, measured at the battery or at the grid connection point), but the app has no schedule editor of its own.
- Pairing (mdns discovery) parses the hostname to detect a Homevolt device and serial number. If you change this pairing will likely fail.
- If mDNS discovery can't find your device (e.g. it's on a different subnet than Homey), you can enter its IP address manually on the pairing screen. If that IP later changes, use "Repair" on the device (in its advanced settings) to update it without re-pairing. The new IP is kept across app and Homey restarts. A fixed IP (DHCP reservation) in your router avoids the problem altogether.


## SIGN-IN AND HTTPS
Newer Homevolt firmware can require sign-in on the local web server, and can serve it over HTTPS.
The app supports both and detects them itself when you add or repair a device:

- **HTTP or HTTPS:** detected automatically. HTTPS is used whenever the Homevolt offers it. If you
  turn the Homevolt's HTTPS option on or off later, the app notices and switches by itself.
- **Sign-in off:** nothing to do. You are never asked for a password, and the app works exactly as
  before.
- **Sign-in on:** the pairing screen asks for the device password (by default, the QR code printed
  on the device) or an access token, but only when the Homevolt actually requires one. For a device
  that is already added, it is under the device's settings → Sign-in, or under Repair. Entering it
  on one Homevolt device in Homey (battery, grid sensor or solar) saves it for all of them.
- **Password or access token:** both work and are entered in the same field. An access token can
  be revoked without changing the device password. Create one in the Homevolt's web interface
  under API tokens, with the `auth` scope: that is enough for everything the app does, including
  the charge/discharge Flow cards. (An `ecu_read` token only allows reading.)
- **Existing installs:** if a firmware update turns sign-in on, the devices go unavailable with a
  message saying so, and Homey shows one notification. Enter the password or token and they recover
  on the next poll.
- **Wrong password:** the Homevolt slows down sign-in attempts after wrong passwords, which would
  also lock you out of its own web interface. So once a password is rejected, the app stops sending
  it until you enter it again. Nothing is retried in the background.
- **HTTPS certificate:** the Homevolt's certificate cannot be verified, because nothing on a home
  network can issue one Homey could check. So the app encrypts the connection but does not check
  the certificate. That protects the password and readings from being read off the network, but it
  does not prove the answering device is your Homevolt.

## PRIVACY
This app can send anonymous usage data to help improve it. It is **off unless you turn it on**,
either from the checkbox on the pairing screen or under Settings → Privacy.

No battery readings, IP addresses, serial numbers, wifi details or device names are ever sent.
[docs/analytics.md](docs/analytics.md) is the full account of what is sent, when, and why.


## LINKS
- Homey app store link [here](https://homey.app/en-se/app/com.homevolt.local/Homevolt/).
- Discussions in the Homey community forum [here](https://community.homey.app/t/app-pro-homevolt/128447).