'use strict';

/**
 * Reports (ADMIN only): analytics JSON + CSV exports (weekly / monthly /
 * custom range). Data comes from the reports service, which reads real
 * Firestore state and audit history.
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const reports = require('../services/reports');
const csvUtil = require('../lib/csv');

const adminGuard = requireRole('ADMIN');

router.get('/reports', adminGuard, (req, res) => {
  res.render('reports', { title: 'Reports & Bottlenecks - Blindspot', me: req.session.employee });
});

const VALID_RANGES = new Set(['this-week', 'last-week', 'this-month', 'last-month', 'custom']);

// GET /api/reports/data?range=this-week&from=&to=
router.get('/api/reports/data', adminGuard, async (req, res, next) => {
  try {
    const rangeKind = String(req.query.range || 'this-week');
    if (!VALID_RANGES.has(rangeKind)) return res.status(400).json({ message: `Unknown report range "${rangeKind}"` });
    const data = await reports.buildReport({
      rangeKind,
      fromIso: req.query.from,
      toIso: req.query.to,
    });
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/reports/export?range=...&from=&to=  (CSV download)
router.get('/api/reports/export', adminGuard, async (req, res, next) => {
  try {
    const rangeKind = String(req.query.range || 'this-week');
    if (!VALID_RANGES.has(rangeKind)) {
      return res.status(400).json({ message: `Unknown report range "${rangeKind}"` });
    }
    const out = await reports.exportCsv({ rangeKind, fromIso: req.query.from, toIso: req.query.to });
    const now = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="blindspot-report-${csvUtil.cleanToken(rangeKind)}-${now}.csv"`);
    res.send(out.csv);
  } catch (err) { next(err); }
});

module.exports = router;
