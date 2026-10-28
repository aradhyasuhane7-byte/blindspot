'use strict';

/** Entry point: loads .env, initializes Firebase, boots the HTTP server. */
require('dotenv').config();

const { init } = require('./server/config/firebase');
const employees = require('./server/services/employees');
const fb = require('./server/config/firebase');
const { createApp } = require('./server/app');
const { seedDemoData } = require('./server/services/seed');

const PORT = Number(process.env.PORT || 8080);

init();

// Confirm the Firestore connection really works (fail fast with clear message).
fb.verify().then((ok) => {
  // One-time setup of the first administrator (remove the env vars afterwards).
  if (ok && (process.env.BLINDSPOT_SETUP_ADMIN_UID || process.env.BLINDSPOT_SETUP_ADMIN_EMAIL)) {
    employees.bootstrapFirstAdmin().catch((err) =>
      console.warn('[blindspot] bootstrap admin failed:', err.message));
  }
  // Demo mode: seed 5 demo employees + 16 demo packages once, at startup.
  if (ok && /^(1|true|yes)$/i.test(process.env.BLINDSPOT_AUTO_SEED_DEMO || '')) {
    seedDemoData({ force: false })
      .then((s) => {
        const fresh = s.employeesCreated.length + s.packagesCreated.length;
        if (fresh > 0) {
          console.log('[blindspot] demo data ready: '
            + s.employeesCreated.length + ' new employee(s), '
            + s.packagesCreated.length + ' new package(s) '
            + '(' + s.packagesSkipped.length + ' existing kept).');
          console.log('[blindspot] demo logins (password demo1234): '
            + 'admin@blindspot.demo / confirm@blindspot.demo / pack@blindspot.demo / '
            + 'doc@blindspot.demo / del@blindspot.demo');
        } else {
          console.log('[blindspot] demo data already present - nothing to seed.');
        }
      })
      .catch((err) =>
        console.warn('[blindspot] demo seeding failed:', err.message || err));
  }
});

const app = createApp();
app.listen(PORT, () => {
  console.log(`[blindspot] running at http://localhost:${PORT}  -  "See every delay. Control every stage."`);
  if (fb.isReady()) {
    console.log('[blindspot] data: Cloud Firestore via Firebase Admin SDK. Authentication: Firebase Auth (email/password).');
  } else {
    console.log('[blindspot] PUBLIC dashboard & pages will render, but data endpoints report "not configured".');
    console.log('[blindspot] ' + fb.notReadyMessage());
  }
});
