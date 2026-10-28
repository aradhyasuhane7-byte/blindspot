'use strict';

/**
 * Public main dashboard. "/" needs no session; all public data comes from
 * /api/public/*, which whitelists only approved fields (never internal
 * remarks, issues, employee emails or auth data).
 */
const express = require('express');
const router = express.Router();
const fb = require('../config/firebase');
const packagesService = require('../services/packages');
const { requireAuth } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    res.render('dashboard', {
      title: 'Blindspot - See every delay. Control every stage.',
      me: req.session && req.session.employee,
    });
  } catch (err) { next(err); }
});

// GET /api/public/summary
router.get('/api/public/summary', async (req, res, next) => {
  try {
    if (!fb.isReady()) {
      // Not configured: keep the public page functional with zeros instead of failing.
      return res.json({
        total: 0, awaitingConfirmation: 0, inPackaging: 0, awaitingDocDispatch: 0,
        inDelivery: 0, delivered: 0, delayed: 0,
        notice: fb.notReadyMessage(),
      });
    }
    await packagesService.reloadCache();
    const dates = require('../lib/dates');
    res.json(packagesService.publicSummary(dates.todayLocal()));
  } catch (err) { next(err); }
});

// GET /api/public/packages?q=&stage=&status=&from=&to=&sort=&dir=
router.get('/api/public/packages', async (req, res, next) => {
  try {
    if (!fb.isReady()) {
      return res.json({ summary: {}, items: [], notice: fb.notReadyMessage() });
    }
    const data = await packagesService.publicData({
      q: req.query.q,
      stage: req.query.stage,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      sort: req.query.sort,
      dir: req.query.dir,
    });
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/public/auth-snapshot - header user chip for cached pages
router.get('/api/public/auth-snapshot', requireAuth, async (req, res) => {
  const me = req.session.employee;
  res.json({ authenticated: true, name: me.name, role: me.role });
});

module.exports = router;
