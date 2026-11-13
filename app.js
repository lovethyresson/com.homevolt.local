'use strict';

const https = require('https');
const Homey = require('homey');
const fetch = require('node-fetch');
const {
  CONSENT_SETTING, initAnalytics, refreshConsent, appVersion, track, reportInstallProfile,
} = require('./lib/analytics');
const {
  SECRET_SETTING, SCHEME_STORE, AUTH_REQUIRED, AUTH_REJECTED, AuthError, RateLimitedError,
  normalizeSecret, authHeaders, retryAfterMs, isAuthProblem,
} = require('./lib/auth');

// Set by Homey only for `homey app run` (dev) sessions, not on installed/published apps.
const DEBUG = process.env.DEBUG === '1';

// App setting: addresses the user has already been notified about needing sign-in.
const AUTH_NOTIFIED_SETTING = 'auth_notified';


/**
 * For hubs with the firmware's HTTPS option on (`webserver_https_enable`).
 *
 * Certificate checks are off because there is nothing to check against: the hub is reached by a
 * LAN IP or a .local name, which no public CA issues for, so its certificate can only be
 * self-signed or private. That still encrypts the password and readings on the wire, which is the
 * point of the option; it does not prove which box answered. (Pinning the certificate seen at
 * pairing would add that, but only once we know the firmware keeps one certificate across reboots
 * and updates - a pinned certificate that rotates would take the device offline.)
 *
 * Keep-alive, because a TLS handshake is expensive for the hub's ESP32 and polling would otherwise
 * do one every 5 seconds. Two sockets at most, so Homey never holds more than a couple of the
 * hub's few server connections, and idle ones are dropped after 30 s.
 */
const HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: false, keepAlive: true, maxSockets: 2, timeout: 30 * 1000,
});

const otherScheme = scheme => (scheme === 'https' ? 'http' : 'https');

/** A 3xx pointing at the given scheme - how a hub would send plain HTTP over to HTTPS. */
function redirectsTo(res, scheme) {
  return res.status >= 300 && res.status < 400
    && String(res.headers.get('location') || '').startsWith(`${scheme}:`);
}

/**
 * Errors that mean "nothing speaks this scheme here", as opposed to "the hub is offline": a
 * refused or reset connection, or a TLS/HTTP protocol mismatch. Timeouts and unreachable hosts are
 * deliberately absent - an offline hub must not be probed twice per poll.
 */
function isWrongSchemeError(error) {
  const code = String(error?.code || '');
  return ['ECONNREFUSED', 'ECONNRESET', 'EPROTO'].includes(code)
    || code.startsWith('ERR_SSL') || code.startsWith('HPE_')
    || /socket hang up|wrong version number|ssl/i.test(String(error?.message || ''));
}

/** Read and discard a body we will not use, so a keep-alive socket goes back to the pool. */
function drain(res) {
  return res.text().catch(() => {});
}

function cacheKey(address, secret) {
  return `${address}\n${normalizeSecret(secret)}`;
}

/** Drop a cached promise, unless it has already been replaced by a newer one. */
function forget(cache, key, promise) {
  if (cache[key] === promise) delete cache[key];
}

module.exports = class HomevoltApp extends Homey.App {

  __statusPromises = {};
  __paramPromises = {};
  // address -> sign-in state learned from the device; see _checkAuthGate().
  __authGates = {};
  // address -> 'http' | 'https'; see schemeFor().
  __schemes = {};

  /**
   * ems.json for one hub, shared by every device polling it. Cached for one polling interval, so
   * the battery, grid sensor and solar device at the same address cost one request per poll.
   *
   * Resolves to null when the hub cannot be reached (callers treat that as "offline"), and
   * rejects with an AuthError/RateLimitedError when it can be reached but refuses us - that is a
   * different problem with a different fix, and the devices say so.
   *
   * The secret is part of the cache key so a pairing attempt with a new password never gets the
   * 401 cached for the old one.
   */
  async getStatus({ address, secret }) {
    const key = cacheKey(address, secret);
    if (!this.__statusPromises[key]) {
      const promise = this._fetchWithRetry(address, '/ems.json', secret);
      this.__statusPromises[key] = promise;
      promise.then(
        // Invalidate cache after polling interval
        () => setTimeout(() => forget(this.__statusPromises, key, promise), this.getPollingInterval() * 1000),
        // Never cache a refusal: the next poll must see a password the user has just entered.
        () => forget(this.__statusPromises, key, promise),
      );
    }

    return this.__statusPromises[key];
  }

  /**
   * status.json (wifi details etc.). Cached for the app's lifetime because it is only read for the
   * settings page - but only once it has actually been read: a null or refused result is retried
   * next time, or a battery that needed a password at boot would show "Unknown" until a restart.
   */
  async getSystem({ address, secret }) {
    const key = cacheKey(address, secret);
    if (!this.__paramPromises[key]) {
      const promise = this._fetchWithRetry(address, '/status.json', secret);
      this.__paramPromises[key] = promise;
      promise.then(
        (data) => { if (!data) forget(this.__paramPromises, key, promise); },
        () => forget(this.__paramPromises, key, promise),
      );
    }

    return this.__paramPromises[key];
  }

  /**
   * The one place that talks HTTP(S) to a hub: picks the scheme, adds the credential and turns
   * 401/429 into typed errors. The JSON endpoints and the battery's console.json both go through
   * here.
   *
   * If the hub stops answering on the scheme we know - its HTTPS option was switched since pairing -
   * the other scheme is tried once and, if that answers, used from then on and stored on the
   * devices. So turning HTTPS on or off needs no repair. Redirects are never followed: node-fetch
   * drops the Authorization header when a redirect changes protocol, so following http -> https
   * would make a correct password look rejected. A redirect to the other scheme is treated as a
   * switch instead.
   *
   * @param {string} address - IP or hostname of the hub
   * @param {string} path - e.g. '/ems.json'
   * @param {object} [options]
   * @param {string} [options.secret] - device password or access token; empty sends no header
   * @param {Buffer|string} [options.body] - must be replayable (not a stream): it may be sent twice
   * @param {number} [options.timeoutMs] - abort after this long; 0 for no timeout
   * @returns {Promise<import('node-fetch').Response>} any response other than 401/429
   */
  async request(address, path, {
    secret, method = 'GET', body, headers = {}, timeoutMs = 5000,
  } = {}) {
    const value = normalizeSecret(secret);
    this._checkAuthGate(address, value);

    const send = scheme => this._send(scheme, address, path, {
      method, body, headers: { ...headers, ...authHeaders(value) }, timeoutMs,
    });
    const scheme = this.schemeFor(address);
    let res;
    try {
      res = await send(scheme);
      if (redirectsTo(res, otherScheme(scheme))) {
        await drain(res);
        res = await this._switchScheme(address, scheme, send, new Error(`${address} redirects to ${otherScheme(scheme)}`));
      }
    } catch (error) {
      if (!isWrongSchemeError(error)) throw error;
      res = await this._switchScheme(address, scheme, send, error);
    }

    if (res.status === 401) {
      await drain(res);
      const reason = value ? AUTH_REJECTED : AUTH_REQUIRED;
      this._recordAuthFailure(address, value, reason);
      throw new AuthError(reason, address);
    }
    if (res.status === 429) {
      await drain(res);
      const waitMs = retryAfterMs(res);
      this.__authGates[address] = { ...this.__authGates[address], rateLimitedUntil: Date.now() + waitMs };
      this.error(`[auth] ${address} is rate limiting sign-in; pausing requests for ${waitMs / 1000} s`);
      throw new RateLimitedError(address, waitMs);
    }

    this._recordAuthSuccess(address);
    return res;
  }

  /**
   * One request on one scheme. A reset connection is retried once, straight away: with keep-alive
   * (always for HTTPS, and Node's default agent for HTTP), the pooled socket may be one the hub has
   * already closed - it does when its web server restarts, e.g. after its HTTPS option is switched -
   * and the first write on it fails before the hub ever sees the request. The retry gets a fresh
   * connection. This is Node's documented remedy for reused keep-alive sockets.
   *
   * GET only. A reset can also come after the hub has acted on a request, and console commands are
   * not all idempotent - a repeated `sched_add` would add the schedule entry twice.
   */
  async _send(scheme, address, path, options = {}) {
    try {
      return await this._sendOnce(scheme, address, path, options);
    } catch (error) {
      if (error?.code !== 'ECONNRESET' || (options.method || 'GET') !== 'GET') throw error;
      return this._sendOnce(scheme, address, path, options);
    }
  }

  async _sendOnce(scheme, address, path, {
    method = 'GET', body, headers = {}, timeoutMs = 5000,
  } = {}) {
    const controller = new AbortController();
    const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetch(`${scheme}://${address}${path}`, {
        method,
        body,
        headers,
        redirect: 'manual',
        agent: scheme === 'https' ? HTTPS_AGENT : undefined,
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Retry on the other scheme; keep it if it answers, else surface the original failure. */
  async _switchScheme(address, from, send, cause) {
    const to = otherScheme(from);
    let res;
    try {
      res = await send(to);
    } catch {
      throw cause;
    }
    if (redirectsTo(res, from)) {
      await drain(res);
      throw cause; // each scheme points at the other: not something to settle here
    }
    this.log(`[transport] ${address} no longer answers over ${from} (${cause.message}); switching to ${to}`);
    await this._rememberScheme(address, to);
    return res;
  }

  /**
   * Which scheme to use for a hub: what this process last saw, else what its devices stored at
   * pairing, repair or a previous switch, else plain HTTP - which is what every device paired
   * before 1.8 used, so they need no migration.
   */
  schemeFor(address) {
    if (!this.__schemes[address]) {
      const stored = this._devicesAt(address).map(device => device.getStoreValue(SCHEME_STORE)).find(Boolean);
      this.__schemes[address] = stored === 'https' ? 'https' : 'http';
    }
    return this.__schemes[address];
  }

  async _rememberScheme(address, scheme) {
    this.__schemes[address] = scheme;
    for (const device of this._devicesAt(address)) {
      if (device.getStoreValue(SCHEME_STORE) === scheme) continue;
      await device.setStoreValue(SCHEME_STORE, scheme)
        .catch(err => this.error(`[transport] Could not store the scheme on ${device.getName()}`, err));
    }
  }

  /**
   * Find out how a hub is served, for pairing and repair. HTTPS is tried first and wins whenever
   * it answers - if a hub serves both, the password should not go over plain HTTP. Any HTTP
   * response counts as an answer, 401 included, and no credential is sent, so this never costs a
   * sign-in attempt.
   *
   * @returns {Promise<'http'|'https'|null>} null when neither answers (the hub is unreachable)
   */
  async detectScheme(address) {
    for (const scheme of ['https', 'http']) {
      try {
        const res = await this._send(scheme, address, '/ems.json');
        await drain(res);
        const found = scheme === 'http' && redirectsTo(res, 'https') ? 'https' : scheme;
        this.log(`[transport] ${address} is served over ${found}`);
        await this._rememberScheme(address, found);
        return found;
      } catch (error) {
        if (DEBUG) this.log(`[transport] ${address} does not answer over ${scheme}: ${error.message}`);
      }
    }
    return null;
  }

  /** Every paired device, of any driver, polling the hub at this address. */
  _devicesAt(address) {
    return Object.values(this.homey.drivers.getDrivers())
      .flatMap(driver => driver.getDevices())
      .filter(device => device.ip === address);
  }

  /**
   * Refuse, without touching the network, requests that are known to fail:
   *
   * - While the hub is rate limiting (429), nothing is sent until Retry-After has passed.
   * - A secret the hub has already rejected is never sent again. The firmware backs off
   *   exponentially on wrong passwords, and a poll every 5 seconds with a stale password would
   *   keep the owner locked out of the battery's own web UI too. It is retried only after the
   *   user enters it again (resetAuth) or the app restarts.
   * - Without any secret, a hub known to need sign-in is asked again once a minute - that costs
   *   no sign-in attempt, and it is how a battery recovers by itself if sign-in is turned off.
   */
  _checkAuthGate(address, secret) {
    const gate = this.__authGates[address];
    if (!gate) return;
    const now = Date.now();
    if (gate.rateLimitedUntil > now) throw new RateLimitedError(address, gate.rateLimitedUntil - now);
    if (secret && gate.rejected?.has(secret)) throw new AuthError(AUTH_REJECTED, address);
    if (!secret && gate.requiredUntil > now) throw new AuthError(AUTH_REQUIRED, address);
  }

  _recordAuthFailure(address, secret, reason) {
    const gate = this.__authGates[address] || {};
    if (reason === AUTH_REJECTED) {
      gate.rejected = gate.rejected || new Set();
      gate.rejected.add(secret);
      this.error(`[auth] ${address} rejected the stored password/token; not sending it again until it is re-entered`);
    } else {
      gate.requiredUntil = Date.now() + 60 * 1000;
      this.error(`[auth] ${address} requires sign-in and no password/token is set`);
    }
    this.__authGates[address] = gate;
    this._notifyAuthProblem(address, reason).catch(err => this.error('[auth] Could not create notification', err));
  }

  _recordAuthSuccess(address) {
    if (!this.__authGates[address]) return;
    delete this.__authGates[address];
    const notified = this.homey.settings.get(AUTH_NOTIFIED_SETTING) || [];
    if (notified.includes(address)) {
      this.homey.settings.set(AUTH_NOTIFIED_SETTING, notified.filter(a => a !== address));
    }
    this.log(`[auth] ${address} accepted the request again`);
  }

  /**
   * Forget what this hub refused, so the next request is sent. Called when the user saves a
   * password/token or repairs the device - a deliberate attempt, which is the only kind worth
   * spending one of the firmware's sign-in attempts on.
   */
  resetAuth(address) {
    delete this.__authGates[address];
  }

  /**
   * Put one timeline notification in front of the user when a paired hub starts refusing us.
   * This is the moment existing users meet sign-in: a firmware update turns it on, the battery
   * goes unavailable, and without this the only explanation is on the device tile.
   *
   * Once per address until it works again, persisted so an app or Homey restart does not repeat
   * it. Skipped while pairing (no paired device at that address yet): the pairing screen already
   * says what is wrong.
   */
  async _notifyAuthProblem(address, reason) {
    if (this._devicesAt(address).length === 0) return;

    const notified = this.homey.settings.get(AUTH_NOTIFIED_SETTING) || [];
    if (notified.includes(address)) return;
    this.homey.settings.set(AUTH_NOTIFIED_SETTING, [...notified, address]);

    const key = reason === AUTH_REJECTED ? 'auth.notification_rejected' : 'auth.notification_required';
    await this.homey.notifications.createNotification({ excerpt: this.homey.__(key) });
  }

  /**
   * A password/token the user already gave another device at this address, so pairing the grid
   * sensor after the battery does not ask for it again.
   */
  knownSecret(address) {
    for (const device of this._devicesAt(address)) {
      const secret = normalizeSecret(device.getSetting(SECRET_SETTING));
      if (secret) return secret;
    }
    return '';
  }

  /**
   * Store a password/token on every device at this address. The three drivers' devices all poll
   * the same hub, so a password entered on one of them is the password for all of them - asking
   * for it three times would be silly, and letting them differ would keep a stale one in use.
   * setSettings() does not call onSettings(), so this cannot loop.
   */
  async shareSecret(address, secret, except) {
    const value = normalizeSecret(secret);
    for (const device of this._devicesAt(address)) {
      if (device === except) continue;
      if (normalizeSecret(device.getSetting(SECRET_SETTING)) === value) continue;
      await device.setSettings({ [SECRET_SETTING]: value })
        .catch(err => this.error(`[auth] Could not share the password with ${device.getName()}`, err));
    }
  }

  /**
   * Fetch JSON with retries for network trouble. Sign-in refusals are rethrown at once: retrying
   * a 401 cannot succeed, and retrying with a password counts against the firmware's limit.
   */
  async _fetchWithRetry(address, path, secret, retries = 3, timeoutMs = 5000) {
    const url = `${address}${path}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      try {
        if (DEBUG) this.log(`[fetch] GET ${url} (attempt ${attempt}/${retries})`);
        const res = await this.request(address, path, { secret, timeoutMs });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const text = await res.text(); // Get raw text first
        if (!text.trim()) {
          throw new Error(`Empty response from ${url}`);
        }

        try {
          const parsed = JSON.parse(text); // Safely parse JSON
          if (DEBUG) this.log(`[fetch] GET ${url} ok after ${Date.now() - startedAt}ms`);
          return parsed;
        } catch (jsonError) {
          throw new Error(`Invalid JSON from ${url}: ${jsonError.message}`);
        }

      } catch (error) {
        if (isAuthProblem(error)) throw error;
        const elapsedMs = Date.now() - startedAt;
        if (attempt < retries) {
          this.log(`Retrying (${attempt}/${retries}) due to error after ${elapsedMs}ms: ${error.message}`);
          await new Promise(res => setTimeout(res, 1000)); // Wait before retry
        } else {
          this.error(`Failed to fetch ${url} after ${retries} attempts (last failure after ${elapsedMs}ms): ${error.message}`);
          return null; // Return `null` instead of throwing to avoid unhandled rejections
        }
      }
    }
    return null;
  }


  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Homevolt App initialized.');

    // Anonymous analytics, off unless the user ticked the box. Without consent this touches
    // nothing: no SDK init, no anonymous id minted, nothing on the wire. See lib/analytics.js.
    initAnalytics(this.homey, this.log.bind(this), this.error.bind(this));
    track('Started App', { app_version: appVersion() });

    // Get the initial polling interval
    const pollingInterval = this.getPollingInterval();
    this.log(`Initial polling interval: ${pollingInterval} seconds`);

    // Listen for changes to the polling interval setting
    this.homey.settings.on('set', async (key) => {
      if (key === 'pollingInterval') {
        const newInterval = this.getPollingInterval();
        this.log(`Polling interval updated to ${newInterval} seconds`);

        // Notify all devices to restart polling
        await this.restartDevicePolling(newInterval);
      }

      // The settings page writes this key directly, so consent flipped there is honored on the
      // next event rather than at the next app start.
      if (key === CONSENT_SETTING) {
        refreshConsent(this.homey);
      }
    });
  }

  /**
   * The hub this is all running on, for the anonymous install profile. Sent as the SDK reports it
   * rather than mapped to a product name: `platform` + `platformVersion` together identify the
   * product, but that mapping is Athom's to change and would rot here.
   *
   * Timezone is the country signal - 'Europe/Stockholm' resolves to a country for every zone that
   * matters, without embedding an IANA->ISO table that goes stale. Language and units are locale,
   * not location: plenty of Swedish users run Homey in English.
   */
  hostFacts() {
    try {
      return {
        homeyVersion: this.homey.version,
        homeyPlatform: this.homey.platform ?? 'local',
        homeyPlatformVersion: this.homey.platformVersion ?? 1,
        timezone: this.homey.clock.getTimezone(),
        language: this.homey.i18n.getLanguage(),
        units: this.homey.i18n.getUnits(),
      };
    } catch (error) {
      this.error('Could not read host facts for the install profile', error);
      return {};
    }
  }

  /**
   * Send the anonymous install profile: what this install *is*, as opposed to what it did.
   *
   * Lives on the app rather than on a driver, which is where com.nibe.local puts its equivalent.
   * That app has one driver hosting all six roles, so a driver knows the whole installation; here
   * the three drivers each know a third of it, and the profile has to be the same whichever
   * drivers happen to be paired. This used to be called from the battery device's initSettings(),
   * which meant an install with only a grid sensor paired sent no profile at all.
   *
   * Synchronous on purpose: it reads already-known state, never the network. `firmware` comes from
   * the latch below, which every driver's poll feeds. Debounced inside reportInstallProfile(), so
   * several devices initialising at once collapse into one identify - and since every call
   * assembles the same install-wide snapshot rather than a caller-scoped one, the last snapshot
   * inside the debounce window is the complete one.
   *
   * @param {object} [caller] - the device asking for the sync, if any. Counted explicitly because
   *   a device calling this from its own onInit may not be in driver.getDevices() yet, and a
   *   single-device install would otherwise report an empty role set.
   */
  syncInstallProfile(caller) {
    try {
      const devices = [];
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        devices.push(...driver.getDevices());
      }
      if (caller && !devices.includes(caller)) devices.push(caller);

      // A set, not a list: two batteries are still one `battery` role, and `roles` answers "which
      // parts does this install have?". Sorted so the same install always sends the same array.
      const roles = [...new Set(devices
        .filter(device => typeof device.analyticsRole === 'function')
        .map(device => device.analyticsRole()))].sort();

      // Battery-specific facts come from a battery device when there is one; duck-typed for the
      // same reason restartDevicePolling() is, so a fourth driver needs no change here. The first
      // such device wins: a battery device already sums packs and rated power across every EMS
      // entry its own hub reports, and two separate hubs in one home is not a shape this profile
      // tries to describe (nor one `control_mode` could describe, since each hub has its own).
      const source = devices.find(device => typeof device.analyticsInstallFacts === 'function');

      reportInstallProfile({
        roles,
        firmware: this.firmwareVersion,
        ...(source ? source.analyticsInstallFacts() : {}),
        ...this.hostFacts(),
      });
    } catch (error) {
      this.error('Could not collect the install profile', error);
    }
  }

  /**
   * Remember the firmware version seen in an ems.json payload, and resync the install profile when
   * it changes.
   *
   * `ems[0].ems_info.fw_version` ('v31.3-6-gbe336a' on the author's unit) is the EMS firmware, and
   * it is what decides which console commands and schedule parameters exist - the thing worth
   * knowing when a report says a card does not work. Verified against a real unit on 2026-08-17:
   * the same value appears in status.json as `ems_status.ems_info.fw_version`, so either endpoint
   * would do; ems.json is the one all three drivers already poll. Deliberately not used instead:
   * `ecu_version`, which is an empty string on that unit, and the ESP/EFR build ids under
   * status.json's `firmware` object, which are build hashes rather than a version. Sent raw, never
   * mapped to a marketing name - a wrong guess here is unfixable, one in Amplitude is reversible.
   *
   * Called from every poll of every driver, so it must stay edge-triggered: it only resyncs when
   * the string actually changes, i.e. on the first successful poll and on a firmware upgrade.
   */
  noteFirmwareVersion(data) {
    const version = data?.ems?.[0]?.ems_info?.fw_version;
    if (typeof version !== 'string' || !version) return;
    if (version === this.firmwareVersion) return;
    this.firmwareVersion = version;
    this.syncInstallProfile();
  }

  getPollingInterval() {
    const defaultPollingInterval = 5; // Default value in seconds
    const pollingInterval = this.homey.settings.get('pollingInterval');
    if (!pollingInterval) {
      return defaultPollingInterval;
    }
    const parsedInterval = parseInt(pollingInterval, 10);
    if (isNaN(parsedInterval) || parsedInterval < 1 || parsedInterval > 60) {
      this.log('Invalid polling interval, using default.');
      return defaultPollingInterval;
    }
    return parsedInterval;
  }

  async restartDevicePolling(newInterval) {
    this.log('Restarting polling for all devices...');

    try {
        // Iterate through all drivers
        const drivers = this.homey.drivers.getDrivers();
        for (const driver of Object.values(drivers)) {
            // Get devices managed by this driver
            const devices = driver.getDevices();
            for (const device of devices) {
                if (typeof device.restartPolling === 'function') {
                    this.log(`Restarting polling for device: ${device.getName()}`);
                    device.restartPolling(newInterval);
                } else {
                    this.log(`Device ${device.getName()} does not implement restartPolling.`);
                }
            }
        }
    } catch (error) {
        this.error('Error while restarting polling for devices:', error.message);
    }
  }
};
