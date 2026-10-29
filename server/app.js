'use strict';

/**
 * Blindspot Express application factory.
 * Routes: / (public dashboard) /login /admin /confirm /pack /doc /del /reports
 */
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const { csrfInit, csrfProtect } = require('./middleware/csrf');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const workflowPages = require('./routes/workflows');
const workflowApi = require('./routes/workflow-api');
const reportRoutes = require('./routes/reports');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');

  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.gstatic.com', 'https://apis.google.com', 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          'wss:',
          'www.googleapis.com',
          'identitytoolkit.googleapis.com',
          'firestore.googleapis.com',
          'firebaseio.com',
          'securetoken.googleapis.com',
        ],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  // Cookie-based session (stateless: works on serverless platforms like
  // Vercel, where in-memory stores would drop sessions between invocations).
  // The login flow clears + rewrites the session (fixation safe).
  app.use(cookieSession({
    name: 'blindspot.sid',
    keys: [process.env.SESSION_SECRET || 'blindspot-dev-secret-change-me'],
    maxAge: 1000 * 60 * 60 * 8, // 8h
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SESSION_SECURE === 'true', // true behind HTTPS in production
  }));

  app.use(csrfInit);
  app.use(csrfProtect);

  // Static assets + pages/APIs.
  // No client-side maxAge: every load revalidates via ETag (cheap 304), so a
  // changed css/js file is picked up by a normal reload. The old 1h cache hid
  // updates behind stale assets and caused "I still see the old bug" reports.
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
  app.use('/', publicRoutes);
  app.use('/', authRoutes);
  app.use('/admin', adminRoutes);
  app.use('/', workflowPages.router);
  app.use('/', workflowApi);
  app.use('/', reportRoutes);

  // Friendly 404 for pages (JSON for APIs)
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ message: 'API endpoint not found' });
    }
    return res.status(404).render('error', {
      title: 'Not found - Blindspot',
      status: 404,
      message: 'The page you requested does not exist.',
      me: req.session && req.session.employee,
    });
  });

  // Error handler (must have all 4 args)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && (err.status || err.status === 503) ? (err.status || 503) : 500;
    const refined = status === 503 ? (err.message || 'Service temporarily unavailable') : (err.message || 'Something went wrong');
    if (status >= 500) console.error('[blindspot] error:', err);
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ message: refined });
    }
    res.status(status).render('error', {
      title: `Error ${status} - Blindspot`,
      status,
      message: refined,
      me: req.session && req.session.employee,
    });
  });

  return app;
}

module.exports = { createApp };
