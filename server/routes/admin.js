'use strict';

/**
 * Admin panel: overview, workflow navigation cards, employee management.
 * Every /admin route is double-checked: router role guard + role re-read
 * from Firestore (middleware) + this module's whitelist of allowed roles.
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const fb = require('../config/firebase');
const packagesService = require('../services/packages');
const employeesService = require('../services/employees');

const adminGuard = requireRole('ADMIN');

router.get('/', adminGuard, (req, res) => {
  res.render('admin', { title: 'Admin Overview - Blindspot', me: req.session.employee, denied: req.query.denied === '1' });
});

// Employees is its own page (the sidebar links it directly; the old single
// /admin page crammed overview + staff management together).
router.get('/employees', adminGuard, (req, res) => {
  res.render('admin-employees', { title: 'Employees - Blindspot', me: req.session.employee, denied: req.query.denied === '1' });
});

// GET /admin/api/summary
router.get('/api/summary', adminGuard, async (req, res, next) => {
  try {
    await packagesService.reloadCache();
    const dates = require('../lib/dates');
    const pkg = packagesService.adminSummary(dates.todayLocal());
    const employees = await employeesService.list({});
    const pendingOver3d = await countStalePending();
    res.json({
      totalPackages: pkg.total,
      active: pkg.total - pkg.delivered,
      delayed: pkg.delayed,
      delivered: pkg.delivered,
      employees: employees.length,
      attention: pkg.delayed + pendingOver3d,
    });
  } catch (err) { next(err); }
});

/** Packages still PENDING at their stage for more than 3 days = need attention. */
async function countStalePending() {
  const packages = await packagesService.listAll();
  const threeDaysAgo = Date.now() - 3 * 86400000;
  return packages.filter((p) => {
    if (p.currentStage === 'DELIVERED' || p.status !== 'PENDING') return false;
    const ms = p.updatedAt && typeof p.updatedAt.toMillis === 'function' ? p.updatedAt.toMillis() : 0;
    return ms && ms < threeDaysAgo;
  }).length;
}

// GET /admin/api/employees?q=&role=&status=
router.get('/api/employees', adminGuard, async (req, res, next) => {
  try {
    if (!fb.isReady()) return res.json({ items: [], notice: fb.notReadyMessage() });
    const items = await employeesService.list({
      q: req.query.q, role: req.query.role, status: req.query.status,
    });
    res.json({ items: items.map(employeesService.view) });
  } catch (err) { next(err); }
});

// POST /admin/api/employees { name, email, password (temporary), role }
router.post('/api/employees', adminGuard, async (req, res, next) => {
  try {
    const created = await employeesService.create(req.body || {});
    res.status(201).json({
      message: `Employee "${created.name}" created with role ${created.role}. `
        + 'Share the temporary password privately and ask them to keep it safe.',
      employee: employeesService.view(created),
    });
  } catch (err) { next(err); }
});

// POST /admin/api/employees/:uid { role?, enabled? }
router.post('/api/employees/:uid', adminGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const wantsRole = body.enabled === undefined || body.role !== undefined;
    const wantsEnable = body.enabled !== undefined;
    if (!wantsRole && !wantsEnable) return res.status(400).json({ message: 'Nothing to update (send role and/or enabled)' });
    let updated = null;
    let message = '';
    if (wantsRole) {
      updated = await employeesService.updateRole(req.params.uid, body.role);
      message += `Role changed to ${body.role}. `;
    }
    if (wantsEnable) {
      updated = await employeesService.setEnabled(req.params.uid, body.enabled === true);
      message += body.enabled === true ? 'Account enabled.' : 'Account disabled. ';
    }
    res.json({ message: message.trim(), employee: employeesService.view(updated) });
  } catch (err) { next(err); }
});

module.exports = router;
