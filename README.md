# Homevolt

This app adds support for connecting your Homevolt battery to Homey. 
Monitor your charge level, charge/discharge pattern and even grid frequency from the Homey app.


## GETTING STARTED
1. Ensure the local web server is enabled (without password)
2. Install the Homevolt for Homey app
3. Add your Homevolt battery and sensors
4. Make sure you configure your sensors as per your requirement. If the Grid sensor is your only incoming measurement, feel free to use that. If not, disable the contribution to home energy in the advanced settings.

---


## CONSIDERATIONS & LIMITATIONS
- This app is using the local webserver to poll data. 
- This is an unsanctioned, non supported API and may break at any point in time.
- This app is not affiliated with Homevolt/Tibber/Polarium.
- Auth is not supported. Password needs to be disabled on the local web server.
- No scheduling support (yet).
- Pairing (mdns discovery) parses the hostname to detect a Homevolt device and serial number. If you change this pairing will likely fail.
- If mDNS discovery can't find your device (e.g. it's on a different subnet than Homey), you can enter its IP address manually on the pairing screen. If that IP later changes, use "Repair" on the device (in its advanced settings) to update it without re-pairing.


## LINKS
- Homey app store link [here](https://homey.app/en-se/app/com.homevolt.local/Homevolt/).
- Discussions in the Homey community forum [here](https://community.homey.app/t/app-pro-homevolt/128447).