'use strict';

/**
 * Device sign-in, as the Homevolt firmware's own web UI does it (read from the device's main.js,
 * 2026-11-12; see CLAUDE.md "Device sign-in"):
 *
 * - Every `*.json`, `/spiffs*` and `/api/*` path answers 401 with `WWW-Authenticate: Bearer`
 *   when sign-in is on and no valid credential is sent.
 * - The credential goes in `Authorization: Bearer <secret>`, with no login round trip. The secret
 *   is either the device password (default: the QR code printed on the device) or an access token
 *   created in the device UI. Both are sent the same way.
 * - Wrong guesses are rate limited: 429 with `Retry-After` in seconds.
 * - With sign-in off, no header is needed - so an empty secret sends none, which keeps every
 *   unit that has not turned sign-in on working exactly as before.
 */

/** Device setting holding the password or token. Shared by every device at the same address. */
const SECRET_SETTING = 'device_password';

/** Device store key: 'http' or 'https', whichever the hub last answered on. See app.schemeFor(). */
const SCHEME_STORE = 'scheme';

/** Cause of an AuthError. */
const AUTH_REQUIRED = 'required'; // 401 with no secret sent: sign-in was turned on
const AUTH_REJECTED = 'rejected'; // 401 with a secret sent: wrong password or revoked token

class AuthError extends Error {
  constructor(reason, address) {
    super(reason === AUTH_REJECTED
      ? `The Homevolt at ${address} rejected the password or access token`
      : `The Homevolt at ${address} requires sign-in`);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

class RateLimitedError extends Error {
  constructor(address, retryAfterMs) {
    super(`The Homevolt at ${address} is blocking sign-in attempts for ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

function normalizeSecret(secret) {
  return typeof secret === 'string' ? secret.trim() : '';
}

function authHeaders(secret) {
  const value = normalizeSecret(secret);
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/** `Retry-After` in ms, bounded to what the device's own UI accepts (1-300 s); 60 s otherwise. */
function retryAfterMs(res) {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 300 ? seconds * 1000 : 60 * 1000;
}

/** True for the errors a device should explain to the user, rather than call "unreachable". */
function isAuthProblem(error) {
  return error instanceof AuthError || error instanceof RateLimitedError;
}

/**
 * The text a device shows while unavailable because of sign-in. Kept here so all three drivers
 * and the pairing screens say the same thing.
 */
function authMessage(homey, error) {
  if (error instanceof RateLimitedError) {
    return homey.__('auth.rate_limited', { seconds: Math.ceil(error.retryAfterMs / 1000) });
  }
  if (error instanceof AuthError && error.reason === AUTH_REJECTED) {
    return homey.__('auth.rejected');
  }
  return homey.__('auth.required');
}

/**
 * Take a device offline with the sign-in explanation, if that is what went wrong. Shared by the
 * three drivers' poll loops; returns false for any other error so the caller handles it as before.
 *
 * Logs only when the kind of problem changes: once refused, the app answers every poll from its
 * gate without touching the network, and a log line every 5 seconds would bury everything else.
 * `device.authProblem` is cleared by the caller on the next successful poll.
 */
async function reportAuthProblem(device, error) {
  if (!isAuthProblem(error)) return false;
  const kind = `${error.name}:${error.reason || ''}`;
  if (device.authProblem !== kind) {
    device.log(`[auth] ${error.message}`);
    device.authProblem = kind;
  }
  await device.setUnavailable(authMessage(device.homey, error)).catch(device.error);
  return true;
}

/**
 * Device onSettings() hook for the password/token field, shared by all three drivers.
 *
 * A non-empty secret is tried against the hub before it is saved, so a typo is reported right in
 * the settings screen instead of as an unavailable device later. A hub that cannot be reached at
 * all does not block saving - it may simply be offline while the user is typing.
 *
 * Once saved it is copied to every other device at the same address (see app.shareSecret), and a
 * poll is scheduled: onSettings() runs before Homey stores the new value, so polling right here
 * would still send the old one.
 */
async function onSecretSettingChanged(device, { newSettings, changedKeys }) {
  if (!changedKeys.includes(SECRET_SETTING)) return;
  const { app } = device.homey;
  const secret = normalizeSecret(newSettings[SECRET_SETTING]);

  app.resetAuth(device.ip);
  if (secret) {
    try {
      await app.getStatus({ address: device.ip, secret });
    } catch (error) {
      if (isAuthProblem(error)) throw new Error(authMessage(device.homey, error));
      throw error;
    }
  }

  await app.shareSecret(device.ip, secret, device);
  device.homey.setTimeout(() => device.fetchData().catch(device.error), 1000);
}

/**
 * What the pairing and repair screens send: `{ ip, secret }`. A bare string is still accepted, so a
 * cached copy of an older pairing page keeps working.
 */
function parseAddressArgs(args) {
  const ip = typeof args === 'string' ? args : args?.ip;
  const address = String(ip || '').trim();
  if (!address) throw new Error('Please enter an IP address');
  return { address, secret: normalizeSecret(args?.secret) };
}

/**
 * Work out how to reach a hub while pairing or repairing: which scheme it is served on, whether it
 * wants sign-in, and - when it does - whether the secret we have is accepted. The user is only
 * asked for a password when the hub actually requires one.
 *
 * The secret tried is the one the user typed, or else `fallbackSecret` (repair: the device's own),
 * or else one already stored on a device at that address, so the grid sensor does not ask again
 * after the battery.
 *
 * Resolves to one of:
 * - `{ data, secret, scheme }` - read; `data` is null and `scheme` null if nothing answered at all.
 * - `{ needsSecret: true, message }` - the hub wants a password, or rejected the one tried. The
 *   pairing screen shows `message` next to the password field.
 * Rate limiting is thrown as an error whose message the screen shows as-is.
 */
async function probeHub(homey, address, enteredSecret, fallbackSecret = '') {
  const { app } = homey;
  const scheme = await app.detectScheme(address);
  if (!scheme) return { data: null, secret: '', scheme: null };

  const secret = normalizeSecret(enteredSecret) || normalizeSecret(fallbackSecret) || app.knownSecret(address);
  try {
    const data = await app.getStatus({ address, secret });
    return { data, secret, scheme };
  } catch (error) {
    if (error instanceof AuthError) return { needsSecret: true, message: authMessage(homey, error) };
    if (isAuthProblem(error)) throw new Error(authMessage(homey, error));
    throw error;
  }
}

/**
 * The parts of a pairing result that carry what probeHub() learned into the new device: the
 * secret, when there is one, and the scheme.
 */
function pairedDeviceExtras({ secret, scheme }) {
  return {
    ...(secret ? { settings: { [SECRET_SETTING]: secret } } : {}),
    ...(scheme ? { store: { [SCHEME_STORE]: scheme } } : {}),
  };
}

module.exports = {
  parseAddressArgs,
  probeHub,
  pairedDeviceExtras,
  reportAuthProblem,
  onSecretSettingChanged,
  SECRET_SETTING,
  SCHEME_STORE,
  AUTH_REQUIRED,
  AUTH_REJECTED,
  AuthError,
  RateLimitedError,
  normalizeSecret,
  authHeaders,
  retryAfterMs,
  isAuthProblem,
  authMessage,
};
