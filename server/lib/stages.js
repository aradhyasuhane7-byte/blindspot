'use strict';

/**
 * Blindspot workflow rules - framework-free, unit-tested core.
 *
 * Lifecycle: Confirmation -> Packaging -> Documentation/Dispatch -> Delivery -> Delivered
 *
 * Rules implemented here (and enforced AGAIN in the Firestore service layer):
 *  1. A new package starts in Confirmation (status PENDING).
 *  2. Packaging cannot start before Confirmation is complete.
 *  3. Documentation/Dispatch cannot start before Packaging is complete.
 *  4. Delivery cannot start before Dispatch/Handover is complete.
 *  5. A package cannot skip a required stage and cannot be marked Delivered
 *     without the completed dispatch/handover data.
 *  6. Delay is a recorded reason OR the expected delivery date passing - never
 *     "stage not finished" by itself.
 */

const STAGES = {
  CONFIRMATION: { label: 'Confirmation', progress: 25, path: 'confirm', roles: ['ADMIN', 'CONFIRM'] },
  PACKAGING: { label: 'Packaging', progress: 50, path: 'pack', roles: ['ADMIN', 'PACK'] },
  DOCUMENTATION_DISPATCH: { label: 'Documentation/Dispatch', progress: 75, path: 'doc', roles: ['ADMIN', 'DOC'] },
  DELIVERY: { label: 'Delivery', progress: 90, path: 'del', roles: ['ADMIN', 'DEL'] },
  DELIVERED: { label: 'Delivered', progress: 100, path: '', roles: [] },
};

const ORDER = ['CONFIRMATION', 'PACKAGING', 'DOCUMENTATION_DISPATCH', 'DELIVERY', 'DELIVERED'];
const ROLES = ['ADMIN', 'CONFIRM', 'PACK', 'DOC', 'DEL'];

const STATUS = {
  PENDING: { label: 'Pending', badge: 'pending' },
  IN_PROGRESS: { label: 'In Progress', badge: 'progress' },
  ATTEMPTED: { label: 'Attempted', badge: 'progress' }, // delivery only
  DELAYED: { label: 'Delayed', badge: 'delayed' },
  COMPLETED: { label: 'Completed', badge: 'completed' },
};

/**
 * Structured delay-reason taxonomy (vision feature #3). Employees MUST pick
 * one of these when recording a delay; the optional explanation refines it.
 * Reports group by these codes, so they must stay stable.
 */
const DELAY_REASONS = {
  MISSING_INFORMATION: 'Missing information',
  MATERIAL_SHORTAGE: 'Material shortage',
  PACKAGING_ISSUE: 'Packaging issue',
  DOCUMENTATION_ERROR: 'Documentation error',
  TRANSPORTER_DELAY: 'Transporter delay',
  OTHER: 'Other',
};

/**
 * Planned completion target per stage, in days from stage start (vision
 * feature #2). The planned deadline for a stage is written when the stage
 * starts; overdue detection compares actual timestamps against it.
 */
const TARGET_DAYS = {
  CONFIRMATION: 2,
  PACKAGING: 3,
  DOCUMENTATION_DISPATCH: 2,
  DELIVERY: 3,
};

/**
 * Allowed transitions per action for the CURRENT stage status.
 * `start` moves to IN_PROGRESS, `resume` recovers DELAYED (delivery also
 * accepts ATTEMPTED back to IN_PROGRESS), `complete` finishes the stage,
 * `delay` records an explicit delay, `record-issue` / `remarks` never change
 * status (bookkeeping).
 */
const ACTIONS = {
  start: { PENDING: 'IN_PROGRESS', ATTEMPTED: 'IN_PROGRESS' },
  resume: { DELAYED: 'IN_PROGRESS', ATTEMPTED: 'IN_PROGRESS' },
  complete: { PENDING: 'COMPLETED', IN_PROGRESS: 'COMPLETED', ATTEMPTED: 'COMPLETED' },
  delay: { PENDING: 'DELAYED', IN_PROGRESS: 'DELAYED', ATTEMPTED: 'DELAYED' },
  recordIssue: null,
  remarks: null,
};

class StageError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'StageError';
    this.status = status;
  }
}

/** Active (not finished) work statuses. */
function isActive(status) {
  return status === 'PENDING' || status === 'IN_PROGRESS' || status === 'ATTEMPTED' || status === 'DELAYED';
}

/** True when the action is legal from the given current status. */
function canApply(action, currentStatus) {
  const map = ACTIONS[action];
  if (map === undefined) throw new StageError(`Unknown action "${action}"`);
  if (map === null) return isActive(currentStatus); // remarks / record-issue bookkeeping
  if (action === 'start') return currentStatus === 'PENDING';
  return Object.prototype.hasOwnProperty.call(map, currentStatus);
}

function assertCanApply(action, currentStatus, label) {
  if (!canApply(action, currentStatus)) {
    throw new StageError(`Cannot ${actionName(action, label)} while stage status is `
      + `${statusLabel(currentStatus)}.`);
  }
  return ACTIONS[action][currentStatus] || 'IN_PROGRESS';
}

function actionName(action, stageLabel) {
  switch (action) {
    case 'start': return `start ${stageLabel || ''}`;
    case 'resume': return 'resume a stage that is not delayed';
    case 'complete': return `complete ${stageLabel || ''}`;
    case 'delay': return 'record a delay';
    default: return action;
  }
}

function statusLabel(code) {
  return (STATUS[code] || {}).label || code;
}

/**
 * Cross-stage guards (mirrored in the service transactions).
 * Returns nothing or throws StageError with a clear message.
 */
function assertStageAllows(p, stageKey) {
  if (p.currentStage !== stageKey) {
    throw new StageError(`${STAGES[stageKey].label} actions are only available while the package `
      + `is at the ${STAGES[stageKey].label} stage (currently ${STAGES[p.currentStage].label}).`);
  }
}

function assertConfirmComplete(p) {
  const c = p.confirmationDetails || {};
  if (c.status !== 'COMPLETED') {
    throw new StageError('Confirmation must be completed before packaging can proceed.');
  }
}

function assertDispatchComplete(p) {
  const d = p.dispatchDetails || {};
  if (d.status !== 'COMPLETED') {
    throw new StageError('Delivery cannot be recorded before dispatch/handover is completed '
      + 'with transporter and tracking information.');
  }
}

function assertDocDataComplete(p) {
  const d = p.documentationDetails || {};
  const dis = p.dispatchDetails || {};
  if (!d.invoiceNumber || !d.shippingDocRef || d.verificationStatus !== 'VERIFIED') {
    throw new StageError('Dispatch completion requires verified documentation '
      + '(invoice number and shipping document reference recorded, status VERIFIED).');
  }
  if (!dis.transporter || !dis.trackingNumber || !dis.dispatchDate) {
    throw new StageError('Dispatch completion requires transporter, tracking number '
      + 'and dispatch/handover date.');
  }
}

/**
 * Delay evaluation (test-friendly): p is a plain package view
 * { currentStage, status, expectedDelivery }.
 */
function delayInfo(p, today) {
  if (p.currentStage === 'DELIVERED') return { key: 'NONE', detail: '', overdueDays: 0 };
  if (p.status === 'DELAYED') return { key: 'RECORDED', detail: p.delayReason || 'Delay recorded', overdueDays: 0 };
  const overdueDays = p.expectedDelivery ? diffDays(p.expectedDelivery, today) : 0;
  if (overdueDays > 0) return { key: 'OVERDUE', detail: `${overdueDays} day${overdueDays === 1 ? '' : 's'} past expected delivery`, overdueDays };
  return { key: 'NONE', detail: '', overdueDays: 0 };
}

function isDelayed(p, today) {
  return delayInfo(p, today).key !== 'NONE';
}

function diffDays(fromIso, today) {
  if (!fromIso) return 0;
  const a = new Date(fromIso + 'T00:00:00').getTime();
  const b = new Date(today + 'T00:00:00').getTime();
  return Math.round((b - a) / 86400000);
}

/** ISO date (yyyy-MM-dd) `days` after `iso` (or after today when iso is falsy). */
function isoPlusDays(iso, days) {
  // Pure UTC calendar math: parsing local midnight then formatting UTC shifts
  // the date back a day for any timezone ahead of UTC (e.g. IST).
  const base = iso ? new Date(iso.slice(0, 10) + 'T00:00:00Z') : new Date();
  base.setUTCHours(0, 0, 0, 0);
  base.setUTCDate(base.getUTCDate() + (Number(days) || 0));
  return base.toISOString().slice(0, 10);
}

const DETAIL_BY_STAGE = {
  CONFIRMATION: 'confirmationDetails',
  PACKAGING: 'packagingDetails',
  DOCUMENTATION_DISPATCH: 'documentationDetails',
  DELIVERY: 'deliveryDetails',
};

/**
 * Stage-level deadline check for the CURRENT active stage (vision feature #2).
 * p needs the raw stage detail maps. Returns { planned, overdueDays, source }:
 * - `planned` is the stored plannedCompletion, or derived from startedAt when
 *   the package predates deadlines, or null when the stage never started.
 * - `overdueDays` counts days past the planned date (0 when on/ahead of it).
 */
function stageDeadlineInfo(p, stageKey, today) {
  const key = DETAIL_BY_STAGE[stageKey];
  const d = key ? p[key] : null;
  if (!d || d.status === 'COMPLETED' || p.currentStage === 'DELIVERED') {
    return { planned: null, overdueDays: 0, source: null };
  }
  let planned = d.plannedCompletion || null;
  let source = d.plannedCompletion ? 'stored' : null;
  if (!planned && d.startedAt) {
    planned = isoPlusDays(fmtTsToIso(d.startedAt), TARGET_DAYS[stageKey]);
    source = 'derived';
  }
  const overdueDays = planned ? Math.max(0, diffDays(planned, today)) : 0;
  return { planned, overdueDays, source };
}

/** Firestore Timestamp | ISO string | Date -> yyyy-MM-dd (UTC-safe enough for day math). */
function fmtTsToIso(ts) {
  if (!ts) return null;
  try {
    if (typeof ts.toMillis === 'function') return new Date(ts.toMillis()).toISOString().slice(0, 10);
    if (typeof ts === 'string') return ts.slice(0, 10);
    if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  } catch (_) { /* fall through */ }
  return null;
}

/** Payload body trimming + required-piece validation for actions. */
function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max || 1000);
  return s === '' ? null : s;
}

module.exports = {
  STAGES, ORDER, ROLES, STATUS, ACTIONS, DELAY_REASONS, TARGET_DAYS,
  StageError, isActive, canApply, assertCanApply, actionName, statusLabel,
  assertStageAllows, assertConfirmComplete, assertDispatchComplete, assertDocDataComplete,
  delayInfo, isDelayed, cleanText, isoPlusDays, stageDeadlineInfo, fmtTsToIso,
};
