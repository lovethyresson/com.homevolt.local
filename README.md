# Homevolt

This app adds support for connecting your Homevolt battery to Homey. 
Monitor your charge level, charge/discharge pattern and even grid frequency from the Homey app.


## GETTING STARTED
1. Enable the local web server on your Homevolt battery
2. Install the Homevolt app for Homey.
3. Add Homey battery device (the actual homevolt battery) and optionally Homevolt sensors (grid represents incoming power to the building, solar represents power from solar).


## CONSIDERATIONS & LIMITATIONS
- This app is using the local webserver to poll data. 
- This is an unsanctioned, non supported API and may break at any point in time.
- This app is not affiliated with Homevolt/Tibber/Polarium.
- Auth is not supported. Password needs to be disabled on the local web server.
- No scheduling support (yet).
- Pairing (mdns discovery) parses the hostname to detect a Homevolt device and serial number. If you change this pairing will fail.