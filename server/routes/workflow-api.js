'use strict';

/**
 * Workflow REST API: view lists, package details, stage actions.
 *
 * Stage roles are enforced ONCE MORE here (in addition to the middleware and
 * the service-layer status machine) so that an employee of one workflow can
 * never update another workflow by calling its URL or API endpoint directly:
 * e.g. POST /api/pack/... requires ADMIN or PACK; a CONFIRM employee gets 403.
 */
const express = require('express');
const router = express.Router();
const fb = require('../config/firebase');
const packagesService = require('../services/packages');
const { requireRole } = require('../middleware/auth');

const PATH_TO_STAGE = {
  confirm: { stage: 'CONFIRMATION', roles: ['ADMIN', 'CONFIRM'] },
  pack: { stage: 'PACKAGING', roles: ['ADMIN', 'PACK'] },
  doc: { stage: 'DOCUMENTATION_DISPATCH', roles: ['ADMIN', 'DOC'] },
  del: { stage: 'DELIVERY', roles: ['ADMIN', 'DEL'] },
};

for (const [pathKey, cfg] of Object.entries(PATH_TO_STAGE)) {
  const base = `/api/${pathKey}`;

  // list: GET /api/confirm/packages?view=&q=
  router.get(`${base}/packages`, requireRole(...cfg.roles), async (req, res, next) => {
    try {
      if (!fb.isReady()) return res.json({ items: [], notice: fb.notReadyMessage() });
      const items = await packagesService.loadForStage(cfg.stage, req.query.view, req.query.q);
      res.json({ items, view: req.query.view || null, stage: cfg.stage });
    } catch (err) { next(err); }
  });

  // detail + history: GET /api/confirm/packages/{code}
  router.get(`${base}/packages/:code`, requireRole(...cfg.roles), async (req, res, next) => {
    try {
      res.json(await packagesService.detail(req.params.code, cfg.stage));
    } catch (err) { next(err); }
  });

  // stage action: POST /api/confirm/packages/{code}/actions
  router.post(`${base}/packages/:code/actions`, requireRole(...cfg.roles), async (req, res, next) => {
    try {
      const message = await packagesService.applyAction(
        cfg.stage, req.params.code, req.body, req.session.employee);
      res.json({ message });
    } catch (err) { next(err); }
  });
}

module.exports = router;
