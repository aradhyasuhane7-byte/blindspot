'use strict';

/**
 * Session-based authorization middleware.
 *
 * The session user is created ONLY inside /auth/session-login after:
 *   1. Firebase Admin SDK verifies the email/password ID token (and revocation)
 *   2. the employees/{uid} document exists
 *   3. enabled === true and role === one of ADMIN|CONFIRM|PACK|DOC|DEL
 *
 * requireRole() RE-READS the employee document from Firestore on every request
 * to protected resources so that disabled accounts and role changes take
 * effect immediately, even mid-session.
 */
const fb = require('../config/firebase');

function current(req) {
  return (req.session && req.session.employee) || null;
}

function requireAuth(req, res, next) {
  const me = current(req);
  if (!me) {
    if (isApi(req)) return res.status(401).json({ message: 'Login required' });
    return res.redirect('/login');
  }
  return next();
}

/**
 * requireRole('ADMIN') / requireRole('ADMIN','CONFIRM')...
 * Verifies the session AND the fresh Firestore profile.
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    const next2 = next; // alias to avoid shadowing under async
    try {
      const me = current(req);
      if (!me) {
        if (isApi(req)) return res.status(401).json({ message: 'Login required' });
        return res.redirect('/login');
      }
      const fsDb = fb.firestore();
      const snap = await fsDb.collection('employees').doc(me.uid).get();
      if (!snap.exists) {
        req.session = null;
        return isApi(req) ? res.status(403).json({ message: 'Employee profile missing' })
          : res.redirect('/login');
      }
      const emp = snap.data();
      if (emp.enabled !== true) {
        req.session = null;
        return isApi(req) ? res.status(403).json({ message: 'Account is disabled' })
          : res.redirect('/login?reason=disabled');
      }
      if (roles.length && !roles.includes(emp.role)) {
        if (isApi(req)) {
          return res.status(403).json({ message: `Access denied: this action requires role ${roles.join(' or ')}` });
        }
        // Send page visitors to the home page that their role actually allows.
        const HOME = { ADMIN: '/admin', CONFIRM: '/confirm', PACK: '/pack', DOC: '/doc', DEL: '/del' };
        return res.redirect(emp.role && HOME[emp.role] ? HOME[emp.role] + '?denied=1' : '/login');
      }
      // Refresh session snapshot (role renames take effect without re-login).
      req.session.employee = {
        uid: me.uid,
        name: emp.name || me.name || '',
        email: emp.email || me.email || '',
        role: emp.role,
        roleLabel: emp.role,
      };
      next2();
    } catch (err) {
      next2(err);
    }
  };
}

function isApi(req) {
  return /(^|\/)api(\/|$)/.test(req.path);
}

module.exports = { requireAuth, requireRole, current };
