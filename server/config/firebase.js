'use strict';

/**
 * Firebase initialization for the Blindspot backend.
 *
 * Priority order:
 *  1) BLINDSPOT_FIREBASE_CREDENTIALS -> service-account JSON file (cert credential)
 *  2) GOOGLE_APPLICATION_CREDENTIALS / ADC -> admin.initializeApp() with defaults (Cloud Run, GCE)
 *
 * The app ALWAYS boots, even without credentials, so the UI can be previewed;
 * every data path reports a clear "not configured" error until Firebase works.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

let status = 'BOOTING';
let detail = 'Set BLINDSPOT_FIREBASE_CREDENTIALS to the path of your Firebase '
  + 'service-account JSON, or run on Google infrastructure with Application '
  + 'Default Credentials. See README.md "Firebase setup".';
let db = null;
let auth = null;

function init() {
  const credPath = process.env.BLINDSPOT_FIREBASE_CREDENTIALS;
  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT; // full service-account JSON as a string (serverless)
  const options = { projectId: process.env.FB_PROJECT_ID || undefined };
  try {
    if (credJson) {
      // Priority 0: raw JSON passed through an environment variable
      // (the standard approach on Vercel/Cloud Run where git-ignored files
      // are not deployed). Accepts the JSON file's exact contents.
      const serviceAccount = JSON.parse(credJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id || options.projectId,
      });
      console.log('[blindspot] Firebase Admin SDK credentials loaded from FIREBASE_SERVICE_ACCOUNT env var.');
    } else if (credPath) {
      const abs = path.resolve(credPath);
      if (!fs.existsSync(abs)) {
        throw new Error(`Service account file not found: ${abs}`);
      }
      const serviceAccount = JSON.parse(fs.readFileSync(abs, 'utf8'));
      admin.initializeApp(Object.assign({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id || options.projectId,
      }, options.projectId ? { projectId: options.projectId } : {}));
    } else {
      admin.initializeApp(options.projectId ? { projectId: options.projectId } : {}); // Application Default Credentials
    }
    db = admin.firestore();
    auth = admin.auth();
    // REST transport instead of gRPC: far friendlier to serverless cold
    // starts (no long-lived channel setup) and the standard choice on
    // platforms like Vercel/Cloud Run. Must be set before any db call.
    try {
      db.settings({ preferRest: true });
      console.log('[blindspot] Firestore using REST transport (preferRest) for serverless-friendly cold starts.');
    } catch (settingsErr) {
      console.warn('[blindspot] Could not apply Firestore REST settings: ' + settingsErr.message);
    }
    // Do NOT promise readiness yet: verify() below confirms credentials really work.
    console.log('[blindspot] Firebase Admin SDK SDK objects created. Project: '
      + (admin.app().options.projectId || '(unspecified)')
      + '. Admin SDK bypasses Firestore rules: enforce authorization in code.');
  } catch (err) {
    status = 'ERROR';
    detail = 'Firebase Admin SDK failed to start: ' + (err && err.message ? err.message : String(err));
    console.warn('[blindspot] ' + detail);
  }
  return status;
}

/**
 * True readiness check: performs a cheap Firestore read with a timeout so a
 * missing/misconfigured service account fails FAST with a clear message
 * instead of hanging requests on gRPC retries.
 */
async function verify() {
  if (!db || status === 'ERROR') {
    if (status !== 'ERROR') status = 'NOT_CONFIGURED';
    return false;
  }
  try {
    const probe = db.collection('employees').limit(1).get();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore probe timed out after 30000 ms')), 30000));
    await Promise.race([probe, timeout]);
    status = 'READY';
    console.log('[blindspot] Firestore connection verified. Data endpoints are live. '
      + 'Remember: Admin SDK bypasses Firestore rules - authorization is enforced server-side.');
    return true;
  } catch (err) {
    detail = 'Firestore is not reachable with the current credentials: '
      + (err && err.message ? String(err.message).split('\n')[0] : String(err));
    if (/timed out/i.test(detail)) {
      // Cold-start network setup can outlive one probe - allow a retry on
      // the next attempt instead of marking this instance permanently dead.
      console.warn('[blindspot] ' + detail + ' (will retry on next attempt)');
      return false;
    }
    status = 'ERROR';
    console.warn('[blindspot] ' + detail);
    return false;
  }
}

function isReady() {
  return status === 'READY';
}

/** Human-readable reason why Firebase is not usable yet. */
function notReadyMessage() {
  return status === 'NOT_CONFIGURED'
    ? 'Firebase is not configured on this server. ' + detail
    : 'Firebase is unavailable: ' + detail;
}

function firestore() {
  if (!isReady()) throw notReadyError();
  return db;
}

function authSdk() {
  if (!isReady()) throw notReadyError();
  return auth;
}

function notReadyError() {
  const e = new Error(notReadyMessage());
  e.status = 503;
  return e;
}

/** Reads a Firestore Timestamp-like value ('' if missing). */
function tsToMs(val) {
  return val && typeof val.toMillis === 'function' ? val.toMillis() : 0;
}

module.exports = { init, verify, isReady, notReadyMessage, firestore, authSdk, tsToMs };
