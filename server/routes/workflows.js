'use strict';

/**
 * Workflow PAGE renders: /confirm /pack /doc /del.
 * The pages render the shell; data and actions flow through
 * /api/{stage}/... (workflow-api.js), which enforces the roles again.
 */
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');

const PAGES = {
  confirm: { title: 'Confirmation Workflow - Blindspot', heading: 'Confirmation', roles: ['ADMIN', 'CONFIRM'] },
  pack: { title: 'Packaging Workflow - Blindspot', heading: 'Packaging', roles: ['ADMIN', 'PACK'] },
  doc: { title: 'Documentation & Dispatch - Blindspot', heading: 'Documentation/Dispatch', roles: ['ADMIN', 'DOC'] },
  del: { title: 'Delivery Workflow - Blindspot', heading: 'Delivery', roles: ['ADMIN', 'DEL'] },
};

// View tabs per page (matches services/packages VIEWS map):
const VIEW_LABELS = {
  confirm: [
    ['pending', 'Pending Confirmation'],
    ['active', 'In Progress'],
    ['completed', 'Completed'],
    ['delayed', 'Delayed'],
  ],
  pack: [
    ['pending', 'Pending Packaging'],
    ['active', 'Packaging In Progress'],
    ['completed', 'Packaging Completed'],
    ['delayed', 'Delayed'],
  ],
  doc: [
    ['awaiting', 'Awaiting Documentation'],
    ['in-progress', 'Documentation In Progress'],
    ['ready', 'Ready for Dispatch'],
    ['dispatched', 'Dispatched'],
    ['delayed', 'Delayed'],
  ],
  del: [
    ['pending', 'Pending Delivery'],
    ['transit', 'In Transit'],
    ['attempted', 'Delivery Attempted'],
    ['delayed', 'Delayed'],
    ['delivered', 'Delivered'],
  ],
};

const guard = requireRole('ADMIN', 'CONFIRM', 'PACK', 'DOC', 'DEL'); // page-level; per-stage listed below

const DEFAULT_VIEWS = { confirm: 'pending', pack: 'pending', doc: 'awaiting', del: 'pending' };

for (const [page, meta] of Object.entries(PAGES)) {
  router.get(`/${page}`, requireRole(...meta.roles), (req, res) => {
    res.render('workflow', {
      title: meta.title,
      me: req.session.employee,
      page,
      heading: meta.heading,
      viewsForPage: VIEW_LABELS[page],
      defaultView: DEFAULT_VIEWS[page],
      denied: req.query.denied === '1',
    });
  });
}

// Convenience: give every workflow employee a generic /workflows -> own page? Not required.
router.get('/', guard, (req, res, next) => next({ status: 404, message: 'Not found' }));

module.exports = { router, PAGES };
