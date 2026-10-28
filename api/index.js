'use strict';

/**
 * Vercel serverless entry point.
 *
 * Runs once per cold start:
 *   1. initialize the Firebase Admin SDK (+ background readiness probe),
 *   2. build the shared Express app (same one `node server.js` uses),
 *   3. export it - @vercel/node accepts an Express app as the handler.
 *
 * If booting throws (missing module, bad bundle, malformed env JSON...), we
 * export a fallback handler that PRINTS the real error instead of the opaque
 * Vercel "FUNCTION_INVOCATION_FAILED" page, so the problem is diagnosable
 * from the deployment URL itself.
 */

let handler;

try {
  const fb = require('../server/config/firebase');
  fb.init();
  // Readiness probe with retries: a cold instance's first Firestore round
  // trip can be slow; keep trying until it sticks (or give up quietly and
  // let a fresh instance try again on the next cold start).
  (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (await fb.verify()) return;
      await new Promise((r) => setTimeout(r, 10000));
    }
  })();

  const { createApp } = require('../server/app');
  handler = createApp();
} catch (err) {
  const detail = (err && err.stack) ? err.stack : String(err);
  console.error('[blindspot] BOOT FAILURE on Vercel:\n' + detail);
  handler = function bootFailure(req, res) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Blindspot failed to boot on Vercel:\n\n' + String(detail).slice(0, 4000));
  };
}

module.exports = handler;
