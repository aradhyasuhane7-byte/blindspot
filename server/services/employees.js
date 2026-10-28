'use strict';

/**
 * Employee management: Firebase Auth accounts + employees/{uid} Firestore docs.
 *
 * Security notes:
 * - Only ADMIN endpoints call this module (guarded in middleware/auth).
 * - The role ALWAYS comes from the server-validated session plus this module's
 *   own whitelist; a client can never escalate to ADMIN by itself.
 * - Disabling writes employees.enabled=false AND disables the Auth account.
 * - The last active administrator can never be demoted or disabled.
 */
const admin = require('firebase-admin');
const fb = require('../config/firebase');
const { ROLES } = require('../lib/stages');
const { fmtTs } = require('../lib/dates');

const MIN_PASSWORD = 6;

class EmployeeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EmployeeError';
    this.status = status;
  }
}

function employeesCol() {
  return fb.firestore().collection('employees');
}

function profileOf(snapshot) {
  if (!snapshot || !snapshot.exists) return null;
  const d = snapshot.data() || {};
  return {
    uid: snapshot.id,
    name: d.name || '',
    email: d.email || '',
    role: d.role,
    enabled: d.enabled !== false,
    createdAt: d.createdAt || null,
  };
}

async function get(uid) {
  return profileOf(await employeesCol().doc(String(uid)).get());
}

async function getByEmail(email) {
  const snap = await employeesCol().where('email', '==', String(email || '').trim().toLowerCase())
    .limit(1).get();
  return snap.empty ? null : profileOf(snap.docs[0]);
}

async function countActiveAdmins() {
  const snap = await employeesCol().where('role', '==', 'ADMIN').where('enabled', '==', true).get();
  return snap.size;
}

/** List with optional filters (server-side only; admin panel). */
async function list({ q, role, status } = {}) {
  let col = employeesCol();
  if (role && ROLES.includes(role)) col = col.where('role', '==', role);
  if (status === 'enabled') col = col.where('enabled', '==', true);
  if (status === 'disabled') col = col.where('enabled', '==', false);
  const snap = await col.get();
  let items = snap.docs.map(profileOf).filter(Boolean);
  items = items.filter((e) => ROLES.includes(e.role) || true);
  const needle = (q || '').trim().toLowerCase();
  if (needle) {
    items = items.filter((e) =>
      (e.name || '').toLowerCase().includes(needle) || (e.email || '').toLowerCase().includes(needle));
  }
  items.sort((a, b) => (b.createdAt ? b.createdAt.toMillis() : 0) - (a.createdAt ? a.createdAt.toMillis() : 0));
  return items;
}

/** Creates the Firebase Auth account + the profile document. Returns the profile. */
async function create({ name, email, password, role }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const pwd = String(password || '');
  if (!cleanName || cleanName.length > 120) throw new EmployeeError('Name is required (max 120 characters)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new EmployeeError('A valid email address is required');
  if (pwd.length < MIN_PASSWORD) throw new EmployeeError(`Temporary password must be at least ${MIN_PASSWORD} characters`);
  if (!ROLES.includes(role)) throw new EmployeeError('Unknown role');

  let user;
  try {
    user = await fb.authSdk().createUser({
      email: cleanEmail,
      emailVerified: false,
      displayName: cleanName,
      password: pwd,
      disabled: false,
    });
  } catch (err) {
    if (err && /email-already-exists/i.test(err.code || '')) {
      try {
        user = await fb.authSdk().getUserByEmail(cleanEmail);
        if (await get(user.uid)) {
          throw new EmployeeError('An employee with this email already exists', 409);
        }
      } catch (e2) {
        if (e2 instanceof EmployeeError) throw e2;
        throw new EmployeeError('This email already has a Firebase account but the profile could not '
          + 'be attached. Verify in the Firebase console or choose another email.', 409);
      }
    } else {
      throw mapAuthError(err);
    }
  }

  await employeesCol().doc(user.uid).set({
    name: cleanName,
    email: cleanEmail,
    role,
    enabled: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { uid: user.uid, name: cleanName, email: cleanEmail, role, enabled: true, createdAt: null };
}

function mapAuthError(err) {
  const code = (err && err.code) || (err && err.message ? err.message : 'error');
  if (/invalid-email/i.test(code)) return new EmployeeError('Invalid email address format');
  if (/email-already-exists/i.test(code)) return new EmployeeError('This email is already registered', 409);
  if (/password/i.test(code)) return new EmployeeError('Invalid password (must be at least 6 characters)');
  if (/configuration-not-found/i.test(code)) return new EmployeeError(
    'Firebase Authentication is not initialized on this project: open the Firebase console '
    + '-> Authentication -> press "Get started", enable Email/Password, then try again.', 503);
  return new EmployeeError('Could not create the Firebase Auth account: ' + code, 502);
}

/** Changes the role; refuses to demote the final active admin. */
async function updateRole(uid, newRole) {
  if (!ROLES.includes(newRole)) throw new EmployeeError('Unknown role');
  const me = await get(uid);
  if (!me) throw new EmployeeError('Employee not found', 404);
  if (me.role === 'ADMIN' && newRole !== 'ADMIN') {
    const admins = await countActiveAdmins();
    if (admins <= 1) throw new EmployeeError('Cannot demote the last active administrator', 409);
  }
  await employeesCol().doc(String(uid)).update({ role: newRole });
  return { ...me, role: newRole };
}

/** Enables/disables the account (Auth + profile); protects the final active admin. */
async function setEnabled(uid, enable) {
  const me = await get(uid);
  if (!me) throw new EmployeeError('Employee not found', 404);
  if (me.role === 'ADMIN' && me.enabled === true && enable === false) {
    const admins = await countActiveAdmins();
    if (admins <= 1) throw new EmployeeError('Cannot disable the last active administrator', 409);
  }
  try {
    await fb.authSdk().updateUser(String(uid), { disabled: !enable });
  } catch (err) {
    throw new EmployeeError('Firebase Auth update failed: '
      + (err && err.code ? err.code : err.message), 502);
  }
  await employeesCol().doc(String(uid)).update({ enabled: enable === true });
  return { ...me, enabled: enable === true };
}

/** One-time bootstrap of the first admin (env BLINDSPOT_SETUP_ADMIN_UID or _EMAIL). */
async function bootstrapFirstAdmin() {
  const uid = process.env.BLINDSPOT_SETUP_ADMIN_UID && process.env.BLINDSPOT_SETUP_ADMIN_UID.trim();
  const email = process.env.BLINDSPOT_SETUP_ADMIN_EMAIL && process.env.BLINDSPOT_SETUP_ADMIN_EMAIL.trim();
  if (!uid && !email) return false;
  let user;
  try {
    user = uid ? await fb.authSdk().getUser(uid)
      : await fb.authSdk().getUserByEmail(String(email).toLowerCase());
  } catch (err) {
    console.warn('[blindspot] Could not bootstrap the first admin: '
      + (err && err.code ? err.code : err.message));
    return false;
  }
  if (await get(user.uid)) {
    console.log('[blindspot] Bootstrap admin already has a profile; skipping. '
      + 'Remember to remove the setup env vars.');
    return false;
  }
  await employeesCol().doc(user.uid).set({
    name: user.displayName || 'Administrator',
    email: user.email,
    role: 'ADMIN',
    enabled: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('[blindspot] First ADMIN employee created for ' + user.email
    + '. Remove the BLINDSPOT_SETUP_ADMIN_* env vars now.');
  return true;
}

const ROLE_LABELS = {
  ADMIN: 'Administrator', CONFIRM: 'Confirmation', PACK: 'Packaging',
  DOC: 'Documentation/Dispatch', DEL: 'Delivery',
};

function view(e) {
  return {
    uid: e.uid,
    name: e.name,
    email: e.email,
    role: e.role,
    roleLabel: ROLE_LABELS[e.role] || e.role,
    enabled: e.enabled === true,
    createdAt: e.createdAt ? fmtTs(e.createdAt) : '',
  };
}

module.exports = {
  EmployeeError, get, getByEmail, list, create, updateRole, setEnabled,
  countActiveAdmins, bootstrapFirstAdmin, view, profileOf,
};
