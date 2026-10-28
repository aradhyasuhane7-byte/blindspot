'use strict';

/**
 * Authentication: /login page + session login/logout.
 *
 * Login flow (email + password only; no PINs):
 *  1. Browsers use the Firebase web SDK to authenticate (login.ejs + firebase-auth.js).
 *  2. The browser posts the Firebase ID token to /auth/session-login.
 *  3. The Firebase ADMIN SDK verifies the token (and revocation state).
 *  4. The employee profile is read from Firestore: must exist, be enabled and
 *     have a valid role.
 *  5. A secure server session is created; the role is stored server-side.
 *  6. The employee is redirected to the home page of their role.
 * Plain-text passwords never touch Firestore, code or logs.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const fb = require('../config/firebase');
const employees = require('../services/employees');
const { requireAuth } = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please wait a few minutes and try again.' },
});

const HOME = { ADMIN: '/admin', CONFIRM: '/confirm', PACK: '/pack', DOC: '/doc', DEL: '/del' };

router.get('/login', async (req, res, next) => {
  if (req.session && req.session.employee) {
    const me = req.session.employee;
    if (HOME[me.role]) return res.redirect(HOME[me.role]);
  }
  try {
    res.render('login', {
      title: 'Employee Login - Blindspot',
      fbConfig: {
        apiKey: process.env.FB_WEB_API_KEY,
        authDomain: process.env.FB_WEB_AUTH_DOMAIN,
        projectId: process.env.FB_WEB_PROJECT_ID,
        appId: process.env.FB_WEB_APP_ID,
      },
      configured: Boolean(process.env.FB_WEB_API_KEY),
      reason: req.query.reason || '',
    });
  } catch (err) { next(err); }
});

router.post('/auth/session-login', loginLimiter, async (req, res, next) => {
  try {
    const idToken = String((req.body && req.body.idToken) || '');
    if (!idToken) return res.status(400).json({ message: 'ID token is missing' });
    if (!fb.isReady()) {
      return res.status(503).json({ message: fb.notReadyMessage() });
    }

    // 1) verify the token (checks signature, expiry and revocation)
    const decoded = await fb.authSdk().verifyIdToken(idToken, true);
    const uid = decoded.uid;

    // 2) load the server-controlled employee profile from Firestore
    const profile = await employees.get(uid);
    if (!profile) {
      return res.status(403).json({
        message: 'Employee profile not found. An administrator must create your '
          + 'Blindspot profile before you can log in.',
        code: 'NO_PROFILE',
      });
    }
    if (profile.enabled !== true) {
      return res.status(403).json({
        message: 'This account is disabled. Contact an administrator.',
        code: 'DISABLED',
      });
    }
    if (!HOME[profile.role]) {
      return res.status(403).json({ message: 'Unknown employee role', code: 'BAD_ROLE' });
    }

    // 3) fixation-safe session (drop any pre-auth state, then write fresh)
    req.session = null;
    req.session = {
      employee: {
        uid: profile.uid,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        loginAt: Date.now(),
      },
    };
    res.json({ redirect: HOME[profile.role], name: profile.name, role: profile.role });
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (/ID-TOEKN-REVOKED|user-token-revoked/i.test(code)) {
      return res.status(401).json({ message: 'Your session was revoked. Please log in again.' });
    }
    if (/argument-error|malformed|invalid/i.test(code)) {
      return res.status(401).json({ message: 'Authentication failed. Please log in again.' });
    }
    next(err);
  }
});

// GET also supported so workers can log out by URL; POST is the UI default.
function logout(req, res) {
  req.session = null;
  res.clearCookie('blindspot.sid');
  res.clearCookie('blindspot.sid.sig');
  res.clearCookie('bs_csrf');
  if (req.accepts('json') && req.path === '/auth/logout') {
    res.json({ redirect: '/login?reason=logout' });
  } else {
    res.redirect('/login?reason=logout');
  }
}

router.post('/auth/logout', requireAuth, logout);
router.get('/auth/logout', logout);

module.exports = router;
