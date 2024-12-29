const { Driver } = require('homey');

class HomevoltDriver extends Driver {
  async onPair(session) {
    this.log('Pairing session started');

    // Listen for the `input` step from the pairing UI
    session.setHandler('input', async (data) => {
      const ipAddress = data.ipaddress;
      this.log('Received IP address:', ipAddress);
    
      // Validate the IP
      try {
        const response = await fetch(`http://${ipAddress}/ems.json`);
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }
    
        // Return device data in the correct structure
        const deviceData = {
          name: `Homevolt (${ipAddress})`,
          data: { id: ipAddress }
        };
        this.log('Device data validated:', deviceData);
    
        return deviceData; // Return the structured data
      } catch (error) {
        this.log('Error during device validation:', error.message);
        throw new Error('Invalid IP address or unreachable device.');
      }
    });
  }
}

module.exports = HomevoltDriver;
