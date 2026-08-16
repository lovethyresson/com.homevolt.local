'use strict';

const { randomUUID } = require('crypto');
const amplitude = require('@amplitude/analytics-node');
const { Identify } = require('@amplitude/analytics-node');

// Anonymous product analytics, off unless the user ticked the box.
//
// Everything analytics-related lives in this one file on purpose: it is the whole surface, so it
// is one file to read when asking "what does this app send?" and one file to delete if the answer
// should become "nothing". The call sites elsewhere are a single `track(...)` line each.
//
// State is module-level rather than carried on the app/device objects. There is exactly one app
// instance per process, and it means `track()` needs no handle - which is what lets a device
// method report without threading an app reference through.
//
// This file is deliberately kept diffable against com.nibe.local/lib/analytics.ts, which is the
// same module in TypeScript. Both apps report into the SAME Amplitude project (see API_KEY), so
// the two taxonomies must stay in step; reading them side by side is how that is maintained.

// Amplitude ingestion key - public by design; move to an env var when you set up environments.
//
// This key is SHARED with com.nibe.local and any future Homey app: one Amplitude project serves
// all of them, and the `app` property below is what separates them again. That is the whole
// reason `app` exists. Do not mint a per-app key - Amplitude charts cannot span projects, so
// splitting the key would permanently foreclose every cross-app question.
const API_KEY = 'a43b0104bed25c3c0a277eda560bbe7b';

// The Amplitude project is in the EU, and an ingestion key is scoped to its project's region: the
// US endpoint rejects an EU key outright. This is NOT a default worth leaving alone - the SDK's is
// 'US' (api2.amplitude.com), which both breaks ingestion here and would ship EU battery owners'
// data to a third country. Stated explicitly so the region is a decision, not an omission.
const SERVER_ZONE = 'EU';

const CONSENT_SETTING = 'analytics_consent';
const DEVICE_ID_SETTING = 'analytics_device_id';

// null until there is both consent and a successful init(). Every track() checks it, so revoking
// consent stops the stream on the next call rather than at the next app start.
let enabled = null;
// amplitude.init() is called at most once per process, whether it is reached from app start or
// from someone ticking the box during pairing. Consent granted mid-session therefore takes effect
// straight away - waiting for a restart would make the checkbox look broken.
let sdkInitialized = false;
let log = () => {};
let logError = () => {};

function analyticsConsent(host) {
  return host.settings.get(CONSENT_SETTING) === true;
}

// Re-reads the stored answer and makes reality match it. Wired to Homey's settings 'set' event in
// app.js, so consent flipped from the settings page - which writes the setting directly - is
// honored immediately and by the same code path as the pairing checkbox. There is no route that
// changes the setting without passing through here.
function refreshConsent(host) {
  if (analyticsConsent(host)) {
    enableIfConsented(host);
    return;
  }
  if (!enabled) return;
  enabled = null;
  pendingProfile = null;
  if (profileTimer) {
    clearTimeout(profileTimer);
    profileTimer = null;
  }
  try {
    amplitude.setOptOut(true);
  } catch (error) {
    logError('Analytics: failed to opt out of the SDK', error);
  }
  log('Analytics: consent withdrawn - tracking stopped');
}

// Called from the pairing checkbox and the settings-page toggle. Revocation takes effect
// immediately: the local gate closes and the SDK is opted out as well, so an event already queued
// inside Amplitude's batcher is dropped rather than flushed after the user said no.
function setAnalyticsConsent(host, consent) {
  host.settings.set(CONSENT_SETTING, consent === true);
  refreshConsent(host);
}

function enableIfConsented(host) {
  if (enabled) return;
  if (!analyticsConsent(host)) {
    log('Analytics: no consent stored - tracking disabled');
    return;
  }

  // Minted on first use and reused afterwards. This is the *only* identifier sent, and it is
  // random: not the battery IP, not a serial, not the wifi SSID. It exists because Amplitude
  // requires a device_id or user_id per event, not because we want to know who anyone is.
  //
  // Homey scopes app settings per app, so a Homey running both this app and com.nibe.local mints
  // two unrelated UUIDs and counts as two Amplitude users. That is deliberate: comparing apps in
  // aggregate does not need household-level linking, and a shared identifier would make the two
  // installs linkable, which is exactly what "random, not a serial" promises it is not.
  let deviceId = host.settings.get(DEVICE_ID_SETTING);
  if (typeof deviceId !== 'string' || !deviceId) {
    deviceId = randomUUID();
    host.settings.set(DEVICE_ID_SETTING, deviceId);
  }

  try {
    amplitude.setOptOut(false);
    if (!sdkInitialized) {
      amplitude.init(API_KEY, { serverZone: SERVER_ZONE });
      sdkInitialized = true;
    }
    // appId is read from the manifest rather than hardcoded, so neither this app nor nibe names
    // itself and a third app gets the separation for free.
    enabled = {
      deviceId,
      appId: String(host.manifest?.id ?? 'unknown'),
      appVersion: String(host.manifest?.version ?? 'unknown'),
    };
    log('Analytics: enabled by consent');
  } catch (error) {
    // A failure here must not take app start with it - the battery is the point, analytics are not.
    logError('Analytics: init failed, tracking disabled', error);
    enabled = null;
  }
}

// Runs from HomevoltApp.onInit, and again if consent is granted later. Without consent it returns
// before the SDK is touched at all: no init, no client, no anonymous id minted, nothing on the wire.
function initAnalytics(host, logger, errorLogger) {
  log = logger;
  logError = errorLogger;
  enableIfConsented(host);
}

function appVersion() {
  return enabled?.appVersion ?? 'unknown';
}

// What the install *is*, as opposed to what it did: how much battery is present, which control
// mode it runs in, and what it is all running on. These go on the anonymous profile as user
// properties rather than onto each event, because the questions worth asking are cross-sectional -
// "of the 3-pack installs, how many run in partner mode?" - and that is a segmentation, not an
// event count.
//
// Deliberately absent: wifi_ssid and wifi_ip. initSettings() in the battery device reads both for
// the device settings page, and neither has any business leaving the LAN.
//
// Fields (all optional except the host facts' own optionality):
//   batteryPacks, ratedCapacityKwh, ratedPowerW, controlMode,
//   homeyVersion, homeyPlatform, homeyPlatformVersion, timezone, language, units

// Several devices finishing onInit at once would otherwise send several near-identical identifies.
// Coalesce into one - the profile is a steady-state fact, so the last snapshot within the window
// is the true one.
const PROFILE_DEBOUNCE_MS = 5000;
let profileTimer = null;
let pendingProfile = null;

function reportInstallProfile(profile) {
  if (!enabled) return;
  pendingProfile = profile;
  if (profileTimer) return;
  profileTimer = setTimeout(() => {
    profileTimer = null;
    const snapshot = pendingProfile;
    pendingProfile = null;
    if (!enabled || !snapshot) return;
    try {
      const identity = new Identify();
      identity.set('app', enabled.appId);
      identity.set('app_version', enabled.appVersion);
      for (const [key, value] of Object.entries({
        battery_packs: snapshot.batteryPacks,
        rated_capacity_kwh: snapshot.ratedCapacityKwh,
        rated_power_w: snapshot.ratedPowerW,
        control_mode: snapshot.controlMode,
        homey_version: snapshot.homeyVersion,
        homey_platform: snapshot.homeyPlatform,
        homey_platform_version: snapshot.homeyPlatformVersion,
        timezone: snapshot.timezone,
        language: snapshot.language,
        units: snapshot.units,
      })) {
        if (value !== undefined) identity.set(key, value);
      }
      amplitude.identify(identity, { device_id: enabled.deviceId })
        .promise
        .catch((error) => logError('Analytics: install profile failed to send', error));
    } catch (error) {
      logError('Analytics: install profile threw before sending', error);
    }
  }, PROFILE_DEBOUNCE_MS);
  // A pending profile must never hold the Homey process open at shutdown.
  profileTimer.unref?.();
}

// The one choke point. Fire-and-forget by design: this is called from poll chains, Flow run
// listeners and capability listeners, and none of them should wait on a network round trip to
// Amplitude. Failures are logged rather than swallowed, but can never reject into the caller.
//
// `app` is merged in here rather than at every call site - that is what makes a single Amplitude
// project able to serve every Homey app. Spread LAST, not first: later keys win in an object
// spread, so this is what actually makes `app` authoritative. A call site passing its own `app`
// is a bug, and it must lose rather than silently mislabel the event as coming from another app.
function track(name, properties) {
  if (!enabled) return;
  try {
    amplitude.track(name, { ...properties, app: enabled.appId }, { device_id: enabled.deviceId })
      .promise
      .then((result) => {
        if (result.code >= 400) {
          logError(`Analytics: "${name}" rejected with ${result.code} ${result.message}`);
        }
      })
      .catch((error) => logError(`Analytics: "${name}" failed to send`, error));
  } catch (error) {
    logError(`Analytics: "${name}" threw before sending`, error);
  }
}

/**
 * Wrap a Flow card run listener so running it is reported without every listener growing a
 * track() call of its own. All twelve of this app's cards are registered in one block in the
 * battery device's onInit, so wrapping there instruments the lot.
 *
 * Deliberately not applied to *trigger* cards: Homey calls a trigger's run listener once per
 * subscribed Flow, so wrapping those would report Flow count rather than user action. Triggers
 * report from their fire site instead.
 *
 * @param {'action'|'condition'} kind - 'action' is a THEN card, 'condition' is an AND card.
 * @param {string} cardId - the Flow card id, reported as the `card` property.
 * @param {Function} runListener - the original listener; its return value is passed through.
 */
function trackedRunListener(kind, cardId, runListener) {
  const eventName = kind === 'condition' ? 'Checked AND Card' : 'Ran THEN Card';
  return async (args, state) => {
    try {
      const result = await runListener(args, state);
      // `result` is what an AND card evaluated to, i.e. whether the Flow carried on past this
      // row. A THEN card's return value is not meaningful, so it is not reported.
      track(eventName, kind === 'condition'
        ? { card: cardId, ok: true, result: result === true }
        : { card: cardId, ok: true });
      return result;
    } catch (error) {
      track(eventName, { card: cardId, ok: false });
      throw error;
    }
  };
}

module.exports = {
  CONSENT_SETTING,
  analyticsConsent,
  setAnalyticsConsent,
  refreshConsent,
  initAnalytics,
  appVersion,
  reportInstallProfile,
  track,
  trackedRunListener,
};
