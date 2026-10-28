'use strict';

/**
 * CLI wrapper: seeds demo employees + demo packages into the configured
 * Firebase project.
 *
 *   npm run seed:demo             -> creates missing employees/packages only
 *   npm run seed:demo -- --force  -> also overwrites existing demo packages
 *
 * Requires the Firebase service-account JSON to be configured first
 * (see README section 1).
 */
require('dotenv').config(); // so npm run seed:demo reads .env exactly like the server does

const { seedDemoCli } = require('../server/services/seed');

seedDemoCli(process.argv.includes('--force')).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error('[seed] failed:', msg);
  if (/configuration-not-found/i.test(msg)) {
    console.error('\n[seed] Firebase Authentication has NEVER been initialized on this project,');
    console.error('[seed] so there is no account backend to create employees in yet.');
    console.error('[seed] One-time fix (less than a minute):');
    console.error('[seed]   1. Open https://console.firebase.google.com/project/'
      + (process.env.FB_PROJECT_ID || 'YOUR-PROJECT-ID') + '/authentication');
    console.error('[seed]   2. Press the blue "Get started" button.');
    console.error('[seed]   3. In the provider list pick "Email/Password" -> Enable -> Save.');
    console.error('[seed]   4. Run again: npm run seed:demo');
  }
  process.exit(1);
});
