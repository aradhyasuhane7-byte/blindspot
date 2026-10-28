'use strict';

/**
 * CSRF protection (double-submit cookie).
 *
 * - On every safe request we (re)issue the cookie bs_csrf and expose the value
 *   to templates/JS.
 * - Every state-changing request (POST/PUT/PATCH/DELETE) must echo the same
 *   value through the X-XSRF-TOKEN header or a `_csrf` body field.
 *
 * The browser fetch wrapper (public/js/firebase-auth.js) sends the header
 * automatically, so normal app usage "just works".
 */
const crypto = require('crypto');

const COOKIE = 'bs_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfInit(req, res, next) {
  let token = req.cookies[COOKIE];
  if (!token || token.length < 24) {
    token = crypto.randomBytes(32).toString('hex');
  }
  // Make it available to templates and the client (cookie must be readable by JS).
  req.csrfToken = token;
  res.locals.csrf = token;
  res.cookie(COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.SESSION_SECURE === 'true',
    maxAge: 1000 * 60 * 60 * 8,
  });
  next();
}

function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  // Session login/logout included on purpose.
  const sent = (req.get('X-XSRF-TOKEN') || (req.body && req.body._csrf) || '').trim();
  if (!sent || !req.csrfToken) {
    return res.status(403).json({ message: 'CSRF token missing. Reload the page and try again.' });
  }
  const a = Buffer.from(sent);
  const b = Buffer.from(req.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ message: 'CSRF token mismatch (stale page?). Reload and retry.' });
  }
  next();
}

module.exports = { csrfInit, csrfProtect };
