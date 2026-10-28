'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel runs this file as a Node function on every invocation (module scope
 * executes once per cold start). It:
 *   1. initializes the Firebase Admin SDK,
 *   2. fires the one-shot readiness probe in the background,
 *   3. builds the shared Express app (same app the `node server.js` entry uses),
 *   4. exports it - Vercel's @vercel/node runtime accepts an Express app
 *      directly as the request handler.
 *
 * Sessions are cookie-based (cookie-session) because serverless instances
 * share no memory; see server/app.js.
 */

const fb = require('../server/config/firebase');
fb.init();
fb.verify().catch(() => { /* app.js surfaces the reason on the next data call */ });

const { createApp } = require('../server/app');
const app = createApp();

module.exports = app;
