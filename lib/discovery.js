'use strict';

/**
 * mDNS discovery results from both strategies, one entry per hub.
 *
 * A Homevolt announces `_http._tcp` while its web server is plain HTTP, and only `_https._tcp`
 * once HTTPS is turned on (observed on the author's unit, 2026-11-13). A Homey driver is bound to
 * one discovery strategy, so the HTTPS one is read by id here; both report the same `host`, which
 * is what device ids are built from, so a hub paired over either keeps the same id.
 */
const STRATEGIES = ['homevolt', 'homevolt_https'];

function discoveredHubs(homey) {
  const byHost = new Map();
  for (const id of STRATEGIES) {
    let results = {};
    try {
      results = homey.discovery.getStrategy(id).getDiscoveryResults();
    } catch (error) {
      // A strategy missing from the manifest must not take pairing down with it.
    }
    for (const result of Object.values(results)) {
      if (result && result.host && !byHost.has(result.host)) byHost.set(result.host, result);
    }
  }
  return [...byHost.values()];
}

module.exports = { discoveredHubs };
