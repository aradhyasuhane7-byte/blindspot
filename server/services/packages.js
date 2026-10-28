'use strict';

/**
 * Package lifecycle service (Firestore).
 *
 * All stage transitions run inside Firestore transactions so concurrent
 * updates cannot double-complete a stage or corrupt the status machine.
 * Every important change appends a history event with the acting employee
 * and server-generated timestamps (audit trail rules 7-11).
 */
const admin = require('firebase-admin');
const fb = require('../config/firebase');
const dates = require('../lib/dates');
const S = require('../lib/stages');

class PackageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PackageError';
    this.status = status;
  }
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;
const DETAIL_KEY = {
  CONFIRMATION: 'confirmationDetails',
  PACKAGING: 'packagingDetails',
  DOCUMENTATION_DISPATCH: 'documentationDetails',
  DELIVERY: 'deliveryDetails',
};

function col() { return fb.firestore().collection('packages'); }
function ref(code) { return col().doc(String(code)); }
function sv() { return admin.firestore.FieldValue.serverTimestamp(); }
function trim(v, max = 1000) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === '' ? null : s;
}
function trimOr(v, fallback) { return trim(v) || fallback; }

/** Readable plain shape from a DocumentSnapshot (stage details as raw maps). */
function fromDoc(code, data) {
  const d = data || {};
  return {
    packageCode: code,
    projectName: d.projectName || '',
    customerName: d.customerName || '',
    publicCustomer: d.publicCustomer === true,
    orderReference: d.orderReference || '',
    orderDetails: d.orderDetails || '',
    currentStage: d.currentStage || 'CONFIRMATION',
    status: d.status || 'PENDING',
    confirmationDetails: { issues: [], ...(d.confirmationDetails || {}) },
    packagingDetails: { issues: [], ...(d.packagingDetails || {}) },
    documentationDetails: { issues: [], ...(d.documentationDetails || {}) },
    dispatchDetails: { ...(d.dispatchDetails || {}) },
    deliveryDetails: { issues: [], ...(d.deliveryDetails || {}) },
    expectedDelivery: d.expectedDelivery || null,
    actualDelivery: d.actualDelivery || null,
    delayReason: d.delayReason || null,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

async function getPackage(code) {
  const snap = await ref(code).get();
  return snap.exists ? fromDoc(snap.id, snap.data()) : null;
}

async function listAll(limit = 2000) {
  const snap = await col().limit(limit).get();
  return snap.docs.map((doc) => fromDoc(doc.id, doc.data()));
}

// ------------------------------------------------------------ create

async function createPackage(body, employee) {
  const packageCode = String(body.packageCode || '').trim();
  const projectName = trim(body.projectName, 120);
  const customerName = trim(body.customerName, 120);
  if (!CODE_RE.test(packageCode)) {
    throw new PackageError('Package ID must be 3-40 characters: letters, numbers, dot, dash or underscore');
  }
  if (!projectName) throw new PackageError('Project name is required');
  if (!customerName) throw new PackageError('Customer name is required');

  const confirmDate = trim(body.confirmDate, 10);
  const expectedDelivery = trim(body.expectedDelivery, 10);
  for (const [label, v] of [['Confirmation date', confirmDate], ['Expected delivery', expectedDelivery]]) {
    if (v && !dates.isIsoDate(v)) throw new PackageError(`${label} must use the yyyy-MM-dd format`);
  }
  if (expectedDelivery && confirmDate && expectedDelivery < confirmDate) {
    throw new PackageError('Expected delivery date should not be earlier than the confirmation date');
  }

  const data = {
    packageCode,
    projectName,
    customerName,
    publicCustomer: body.publicCustomer === true,
    orderReference: trim(body.orderReference, 120),
    orderDetails: trim(body.orderDetails, 2000),
    currentStage: 'CONFIRMATION',
    status: 'PENDING',
    confirmationDetails: {
      status: 'PENDING', confirmDate: confirmDate || null, startedAt: null,
      completedAt: null, remarks: trim(body.remarks, 2000), missingInfo: null, issues: [],
    },
    packagingDetails: { status: 'PENDING', startedAt: null, completedAt: null, remarks: null, delayReason: null, issues: [] },
    documentationDetails: { status: 'PENDING', startedAt: null, invoiceNumber: null, shippingDocRef: null, verificationStatus: 'PENDING', verifiedAt: null, remarks: null, issues: [] },
    dispatchDetails: { status: 'PENDING', transporter: null, trackingNumber: null, dispatchDate: null, completedAt: null, delayReason: null, remarks: null },
    deliveryDetails: { status: 'PENDING', startedAt: null, expectedDelivery: expectedDelivery || null, actualDelivery: null, attempts: 0, delayReason: null, remarks: null, issues: [] },
    expectedDelivery: expectedDelivery || null,
    actualDelivery: null,
    delayReason: null,
    createdAt: sv(),
    updatedAt: sv(),
  };

  try {
    await ref(packageCode).create(data);
  } catch (err) {
    if (err && (String(err.code || '') === '6' || /already-exists/i.test(String(err.code || '') + String(err.message || '')))) {
      throw new PackageError(`Package ID "${packageCode}" already exists - package IDs must be unique`, 409);
    }
    throw err;
  }
  await addHistory(packageCode, 'CONFIRMATION', 'N/A', 'PENDING', employee,
    'Package created at the Confirmation stage', 'create', null);
  return getPackage(packageCode);
}

/** History writer (audit trail; server timestamp). */
async function addHistory(code, stageKey, previousStatus, nextStatus, employee, remarks, action, reason) {
  await ref(code).collection('history').add({
    stage: stageKey,
    previousStatus: previousStatus || 'N/A',
    newStatus: nextStatus || 'N/A',
    updatedBy: employee ? employee.name : 'system',
    updatedById: employee ? employee.uid : 'system',
    timestamp: sv(),
    remarks: remarks || '',
    action: action || '',
    reason: reason || '',
  });
}

// -------------------------------------------------------- transitions

/**
 * Single entry point for every stage action.
 * body: { action, remarks, ... action-specific fields }
 */
async function applyAction(stageKey, code, body, employee) {
  const action = String((body && body.action) || '').trim();
  if (!S.STAGES[stageKey] || stageKey === 'DELIVERED') throw new PackageError('Unknown stage', 400);

  const say = await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref(code));
    if (!snap.exists) throw new PackageError(`Package "${code}" was not found`, 404);
    const pkg = fromDoc(snap.id, snap.data());
    const u = {};                       // dotted-path updates
    const sub = pkg[DETAIL_KEY[stageKey]] || {};
    const curStatus = sub.status || 'PENDING';
    let message = '';

    // status transitions helper
    function go(target) {
      u[`${DETAIL_KEY[stageKey]}.status`] = target;
      if (target === 'IN_PROGRESS' && !sub.startedAt) u[`${DETAIL_KEY[stageKey]}.startedAt`] = sv();
      if (target === 'COMPLETED' && !sub.startedAt) u[`${DETAIL_KEY[stageKey]}.startedAt`] = sub.startedAt || pkg.createdAt || sv();
      if (target === 'COMPLETED') u[`${DETAIL_KEY[stageKey]}.completedAt`] = sub.completedAt || sv();
      if (stageKey === pkg.currentStage) {
        pkg.status = target;
        u.status = target;
      }
    }

    function issue(note) {
      pushIssue(u, DETAIL_KEY[stageKey], note, employee);
    }

    function advance() {
      const idx = S.ORDER.indexOf(pkg.currentStage);
      const nxt = S.ORDER[idx + 1];
      if (!nxt || nxt === 'DELIVERED') return;
      pkg.currentStage = nxt;
      pkg.status = 'PENDING';
      u.currentStage = nxt;
      u.status = 'PENDING';
    }

    const remarks = trim(body.remarks, 2000);
    const note = trim(body.issueNote, 500);

    // ---- validate: the stage being acted on must be the package's current stage
    function mustStage() {
      if (pkg.currentStage !== stageKey) {
        throw new S.StageError(`${S.STAGES[stageKey].label} actions are only available while the package is at the `
          + `${S.STAGES[stageKey].label} stage (currently at ${S.STAGES[pkg.currentStage].label})`);
      }
    }

    switch (`${stageKey}:${action}`) {
      // -------------------------------------------------- CONFIRMATION
      case 'CONFIRMATION:start':
        mustStage(); S.assertCanApply('start', curStatus, S.STAGES.CONFIRMATION.label);
        go('IN_PROGRESS');
        message = 'Confirmation started';
        break;

      case 'CONFIRMATION:complete': {
        mustStage(); S.assertCanApply('complete', curStatus, S.STAGES.CONFIRMATION.label);
        const from = curStatus;
        go('COMPLETED');
        advance();
        message = 'Confirmation completed - the package is now waiting for Packaging';
        tx.create(ref(code).collection('history').doc(), ev(stageKey, from, 'COMPLETED', employee,
          `${actionRemarks('complete', remarks)}`, 'complete'));
        tx.create(ref(code).collection('history').doc(), ev('PACKAGING', 'COMPLETED', 'PENDING', employee,
          'Stage advanced to Packaging (pending)', 'advance'));
        return message; // history written above; skips the generic writer below
      }

      case 'CONFIRMATION:missing-info': {
        mustStage(); S.assertCanApply('remarks', curStatus, S.STAGES.CONFIRMATION.label);
        const info = trimOr(body.missingInfo, null) || remarks;
        if (!info) throw new PackageError('Describe the missing information (or write a note in Comments)');
        u['confirmationDetails.missingInfo'] = info;
        issue(`Missing information: ${info}`);
        message = 'Missing information recorded';
        break;
      }

      // -------------------------------------------------- shared delay / issue / remarks
      case 'CONFIRMATION:delay':
      case 'PACKAGING:delay':
      case 'DOCUMENTATION_DISPATCH:delay':
      case 'DELIVERY:delay': {
        mustStage(); S.assertCanApply('delay', curStatus, S.STAGES[stageKey].label);
        const reason = trimOr(body.delayReason, null) || remarks;
        if (!reason) throw new PackageError('A delay reason is required to mark a package delayed');
        u[`${DETAIL_KEY[stageKey]}.delayReason`] = reason;
        u.delayReason = reason;
        go('DELAYED');
        issue(`Delayed: ${reason}`);
        message = 'Delay recorded';
        break;
      }

      case 'CONFIRMATION:record-issue':
      case 'PACKAGING:record-issue':
      case 'DOCUMENTATION_DISPATCH:record-issue':
      case 'DELIVERY:record-issue': {
        mustStage(); S.assertCanApply('remarks', curStatus, S.STAGES[stageKey].label);
        if (!note && !remarks) throw new PackageError('Describe the issue (use the note field)');
        issue(note || remarks);
        message = 'Issue recorded';
        break;
      }

      case 'CONFIRMATION:remarks':
      case 'PACKAGING:remarks':
      case 'DOCUMENTATION_DISPATCH:remarks':
      case 'DELIVERY:remarks': {
        mustStage(); S.assertCanApply('remarks', curStatus, S.STAGES[stageKey].label);
        if (!remarks) throw new PackageError('Write the remarks before saving');
        u[`${DETAIL_KEY[stageKey]}.remarks`] = remarks;
        message = 'Remarks saved';
        break;
      }

      // -------------------------------------------------- PACKAGING
      case 'PACKAGING:start':
        mustStage(); S.assertConfirmComplete(pkg); S.assertCanApply('start', curStatus, S.STAGES.PACKAGING.label);
        go('IN_PROGRESS');
        message = 'Packaging started';
        break;

      case 'PACKAGING:complete': {
        mustStage(); S.assertConfirmComplete(pkg); S.assertCanApply('complete', curStatus, S.STAGES.PACKAGING.label);
        const from = curStatus;
        go('COMPLETED');
        advance();
        message = 'Packaging completed - the package is now waiting for Documentation/Dispatch';
        tx.create(ref(code).collection('history').doc(), ev(stageKey, from, 'COMPLETED', employee,
          actionRemarks('complete', remarks), 'complete'));
        tx.create(ref(code).collection('history').doc(), ev('DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', employee,
          'Stage advanced to Documentation/Dispatch (pending)', 'advance'));
        return message;
      }

      // -------------------------------------------------- DOCUMENTATION / DISPATCH
      case 'DOCUMENTATION_DISPATCH:start-doc':
        mustStage(); S.assertCanApply('start', curStatus, 'documentation');
        go('IN_PROGRESS');
        message = 'Documentation in progress';
        break;

      case 'DOCUMENTATION_DISPATCH:save-doc':
        mustStage(); S.assertCanApply('remarks', curStatus, 'documentation');
        {
          const inv = trimOr(body.invoiceNumber, null);
          const dref = trimOr(body.shippingDocRef, null);
          if (!inv && !dref) throw new PackageError('Enter the invoice number and/or shipping document reference');
          if (inv) u['documentationDetails.invoiceNumber'] = inv;
          if (dref) u['documentationDetails.shippingDocRef'] = dref;
          if (curStatus === 'PENDING') go('IN_PROGRESS');
        }
        message = 'Documentation saved';
        break;

      case 'DOCUMENTATION_DISPATCH:verify':
        mustStage(); S.assertCanApply('remarks', curStatus, 'documentation');
        {
          const inv = trimOr(body.invoiceNumber, null) || sub.invoiceNumber;
          const dref = trimOr(body.shippingDocRef, null) || sub.shippingDocRef;
          if (!inv || !dref) {
            throw new PackageError('Documents cannot be verified until the invoice number and shipping '
              + 'document reference are recorded (use Save documentation first)');
          }
          u['documentationDetails.invoiceNumber'] = inv;
          u['documentationDetails.shippingDocRef'] = dref;
          u['documentationDetails.verificationStatus'] = 'VERIFIED';
          u['documentationDetails.verifiedAt'] = sub.verifiedAt || sv();
          if (curStatus === 'PENDING') go('IN_PROGRESS');
          if (pkg.currentStage === stageKey && (pkg.dispatchDetails.status || 'PENDING') === 'PENDING') {
            u['dispatchDetails.status'] = 'READY';
          }
        }
        message = 'Documents verified - the package is ready for dispatch';
        break;

      case 'DOCUMENTATION_DISPATCH:record-missing-docs':
        mustStage(); S.assertCanApply('remarks', curStatus, 'documentation');
        {
          const miss = trimOr(body.missingInfo, null) || remarks;
          if (!miss) throw new PackageError('State which documents are missing');
          u['documentationDetails.verificationStatus'] = 'MISSING';
          issue(`Missing documents: ${miss}`);
        }
        message = 'Missing documentation recorded';
        break;

      case 'DOCUMENTATION_DISPATCH:save-dispatch':
        mustStage(); S.assertCanApply('remarks', curStatus, 'dispatch');
        {
          const transporter = trimOr(body.transporter, null);
          const tracking = trimOr(body.trackingNumber, null);
          const dDate = trimOr(body.dispatchDate, null);
          if (!transporter && !tracking && !dDate) {
            throw new PackageError('Nothing to save: add transporter, tracking number or dispatch date');
          }
          if (dDate) {
            if (!dates.isIsoDate(dDate)) throw new PackageError('Dispatch date must use the yyyy-MM-dd format');
            u['dispatchDetails.dispatchDate'] = dDate;
          }
          if (transporter) u['dispatchDetails.transporter'] = transporter;
          if (tracking) u['dispatchDetails.trackingNumber'] = tracking;
        }
        message = 'Dispatch/handover information saved';
        break;

      case 'DOCUMENTATION_DISPATCH:complete': {
        mustStage(); S.assertCanApply('complete', curStatus, S.STAGES.DOCUMENTATION_DISPATCH.label);
        {
          const inv = sub.invoiceNumber;
          const dref = sub.shippingDocRef;
          const transporter = sub.transporter;
          const tracking = sub.trackingNumber;
          const dDate = sub.dispatchDate || trimOr(body.dispatchDate, null);
          if (!inv || !dref) {
            throw new PackageError('Dispatch completion requires recorded documentation '
              + '(invoice number and shipping document reference)');
          }
          if (!transporter || !tracking || !dDate) {
            throw new PackageError('Dispatch completion requires transporter, tracking number and '
              + 'dispattch/handover date (use Save dispatch information first)');
          }
          if (!dates.isIsoDate(dDate)) throw new PackageError('Dispatch date must use the yyyy-MM-dd format');
          u['dispatchDetails.dispatchDate'] = dDate;
        }
        {
          const from = curStatus;
          u['dispatchDetails.status'] = 'COMPLETED';
          u['dispatchDetails.completedAt'] = sub.completedAt || sv();
          go('COMPLETED');
          advance();
          message = 'Dispatch/handover completed - the package is now waiting for Delivery';
          tx.create(ref(code).collection('history').doc(), ev(stageKey, from, 'COMPLETED', employee,
            actionRemarks('complete', remarks), 'complete'));
          tx.create(ref(code).collection('history').doc(), ev('DELIVERY', 'COMPLETED', 'PENDING', employee,
            'Stage advanced to Delivery (pending)', 'advance'));
          return message;
        }
      }

      // -------------------------------------------------- DELIVERY
      case 'DELIVERY:start':
        mustStage(); S.assertDispatchComplete(pkg); S.assertCanApply('start', curStatus, S.STAGES.DELIVERY.label);
        go('IN_PROGRESS');
        message = 'Delivery in transit';
        break;

      case 'DELIVERY:attempt':
        mustStage();
        if (curStatus !== 'IN_PROGRESS' && curStatus !== 'ATTEMPTED') {
          throw new S.StageError('A delivery attempt can only be recorded while in transit '
            + `(current status: ${S.statusLabel(curStatus)})`);
        }
        u['deliveryDetails.attempts'] = (Number(sub.attempts) || 0) + 1;
        go('ATTEMPTED');
        if (!sub.startedAt) u['deliveryDetails.startedAt'] = sv();
        if (note || remarks) issue(note || remarks);
        message = 'Delivery attempt recorded';
        break;

      case 'DELIVERY:resume':
        mustStage(); S.assertCanApply('resume', curStatus, S.STAGES.DELIVERY.label);
        go('IN_PROGRESS');
        u.delayReason = null;
        u['deliveryDetails.delayReason'] = null;
        message = 'Delivery resumed';
        break;

      case 'DELIVERY:update-expected':
        mustStage();
        {
          const nd = trimOr(body.expectedDelivery, null);
          if (!nd || !dates.isIsoDate(nd)) throw new PackageError('Enter the new expected delivery date (yyyy-MM-dd)');
          u.expectedDelivery = nd;
          u['deliveryDetails.expectedDelivery'] = nd;
          if (remarks) u['deliveryDetails.remarks'] = remarks;
        }
        message = 'Expected delivery date updated';
        break;

      case 'DELIVERY:complete': {
        mustStage(); S.assertDispatchComplete(pkg); S.assertCanApply('complete', curStatus, S.STAGES.DELIVERY.label);
        const from = curStatus;
        go('COMPLETED');
        u['deliveryDetails.actualDelivery'] = sv();
        u.actualDelivery = sv();
        pkg.currentStage = 'DELIVERED';
        pkg.status = 'COMPLETED';
        u.currentStage = 'DELIVERED';
        u.status = 'COMPLETED';
        message = 'Package delivered - the public dashboard updates automatically';
        tx.create(ref(code).collection('history').doc(), ev(stageKey, from, 'COMPLETED', employee,
          actionRemarks('complete', remarks), 'complete'));
        tx.create(ref(code).collection('history').doc(), ev('DELIVERED', 'COMPLETED', 'COMPLETED', employee,
          'Package marked as delivered', 'deliver'));
        return message;
      }

      default:
        throw new PackageError(`Unknown action "${action}" for stage ${stageKey}`, 400);
    }

    u.updatedAt = sv();
    tx.update(ref(code), u);
    tx.create(ref(code).collection('history').doc(), ev(stageKey, curStatus, pkg.status, employee,
      actionRemarks(action, remarks), action, trimOr(body.delayReason, null)));

    return message;
  }).catch((err) => {
    if (err instanceof S.StageError) throw new PackageError(err.message, 409);
    throw err;
  });

  return say;
}

function ev(stageKey, previousStatus, nextStatus, employee, remarks, action, reason) {
  return {
    stage: stageKey,
    previousStatus: previousStatus || 'N/A',
    newStatus: nextStatus || 'N/A',
    updatedBy: employee ? (employee.name || employee.uid) : 'system',
    updatedById: employee ? employee.uid : 'system',
    timestamp: sv(),
    remarks: remarks || '',
    action: action || '',
    reason: reason || '',
  };
}

function actionRemarks(action, remarks) {
  const base = {
    start: 'Stage started', complete: 'Stage completed', delay: 'Delay recorded',
    resume: 'Stage resumed', 'record-issue': 'Issue recorded', remarks: 'Remarks saved',
    'start-doc': 'Documentation started', 'save-doc': 'Documentation saved',
    verify: 'Documents verified', 'record-missing-docs': 'Missing documents recorded',
    'save-dispatch': 'Dispatch information saved', 'update-expected': 'Expected delivery updated',
    attempt: 'Delivery attempt recorded', deliver: 'Package delivered',
  }[action] || action;
  return remarks ? `${base} - ${remarks}` : base;
}

/** Appends an issue note into a detail map via dotted-path update. */
function pushIssue(u, detailKey, note2, employee) {
  const list = u[`${detailKey}.issues`] || [];
  list.push({ note: note2, by: employee ? employee.name : 'system', at: sv() });
  u[`${detailKey}.issues`] = list;
}

// ------------------------------------------------------------ views

function stageStatusOf(pkg, stageKey) {
  const m = pkg[DETAIL_KEY[stageKey]] || {};
  return m.status || 'PENDING';
}

function fmtIssues(list) {
  return (list || []).map((i) => ({
    note: i.note || '', by: i.by || '', at: i.at ? dates.fmtTs(i.at) : '',
  }));
}

/** Workflow view (internal fields are allowed here; endpoints are role-guarded). */
function workflowView(p, today) {
  const stageKey = p.currentStage;
  const delayed = S.delayInfo(p, today);
  return {
    packageCode: p.packageCode,
    projectName: p.projectName,
    customerName: p.customerName,
    orderReference: p.orderReference,
    orderDetails: p.orderDetails,
    publicCustomer: p.publicCustomer,
    currentStage: stageKey,
    stageLabel: S.STAGES[stageKey].label,
    status: p.status,
    statusLabel: S.STATUS[p.status].label,
    badge: S.STATUS[p.status].badge,
    progress: S.STAGES[stageKey].progress,
    expectedDelivery: p.expectedDelivery || '',
    delayKey: delayed.key,
    delayDetail: delayed.detail,
    delayReason: p.delayReason || '',
    isDelayed: delayed.key !== 'NONE',
    createdAt: dates.fmtTs(p.createdAt),
    updatedAt: dates.fmtTs(p.updatedAt),
    confirmation: {
      status: stageStatusOf(p, 'CONFIRMATION'),
      statusLabel: S.STATUS[stageStatusOf(p, 'CONFIRMATION')].label,
      confirmDate: p.confirmationDetails.confirmDate ? dates.prettyIso(p.confirmationDetails.confirmDate) : '',
      startedAt: dates.fmtTs(p.confirmationDetails.startedAt),
      completedAt: dates.fmtTs(p.confirmationDetails.completedAt),
      remarks: p.confirmationDetails.remarks || '',
      missingInfo: p.confirmationDetails.missingInfo || '',
      issues: fmtIssues(p.confirmationDetails.issues),
    },
    packaging: {
      status: stageStatusOf(p, 'PACKAGING'),
      statusLabel: S.STATUS[stageStatusOf(p, 'PACKAGING')].label,
      startedAt: dates.fmtTs(p.packagingDetails.startedAt),
      completedAt: dates.fmtTs(p.packagingDetails.completedAt),
      remarks: p.packagingDetails.remarks || '',
      delayReason: p.packagingDetails.delayReason || '',
      issues: fmtIssues(p.packagingDetails.issues),
    },
    documentation: {
      status: stageStatusOf(p, 'DOCUMENTATION_DISPATCH'),
      statusLabel: S.STATUS[stageStatusOf(p, 'DOCUMENTATION_DISPATCH')].label,
      verificationStatus: p.documentationDetails.verificationStatus || 'PENDING',
      invoiceNumber: p.documentationDetails.invoiceNumber || '',
      shippingDocRef: p.documentationDetails.shippingDocRef || '',
      remarks: p.documentationDetails.remarks || '',
      issues: fmtIssues(p.documentationDetails.issues),
    },
    dispatch: {
      status: (p.dispatchDetails.status || 'PENDING') === 'READY' ? 'READY' : (p.dispatchDetails.status || 'PENDING'),
      transporter: p.dispatchDetails.transporter || '',
      trackingNumber: p.dispatchDetails.trackingNumber || '',
      dispatchDate: p.dispatchDetails.dispatchDate ? dates.prettyIso(p.dispatchDetails.dispatchDate) : '',
      delayReason: p.dispatchDetails.delayReason || '',
      remarks: p.dispatchDetails.remarks || '',
    },
    delivery: {
      status: stageStatusOf(p, 'DELIVERY'),
      statusLabel: p.deliveryDetails.status === 'ATTEMPTED' ? 'Delivery Attempted'
        : p.currentStage === 'DELIVERED' ? 'Delivered'
          : S.STATUS[stageStatusOf(p, 'DELIVERY')].label,
      startedAt: dates.fmtTs(p.deliveryDetails.startedAt),
      expectedDelivery: p.deliveryDetails.expectedDelivery ? dates.prettyIso(p.deliveryDetails.expectedDelivery) : '',
      actualDelivery: dates.fmtTs(p.deliveryDetails.actualDelivery),
      attempts: Number(p.deliveryDetails.attempts) || 0,
      delayReason: p.deliveryDetails.delayReason || '',
      remarks: p.deliveryDetails.remarks || '',
      issues: fmtIssues(p.deliveryDetails.issues),
    },
  };
}

/**
 * List packages for one workflow stage.
 * view: per-stage buckets, see VIEWS.
 */
const VIEWS = {
  CONFIRMATION: ['pending', 'active', 'completed', 'delayed'],
  PACKAGING: ['pending', 'active', 'completed', 'delayed'],
  DOCUMENTATION_DISPATCH: ['awaiting', 'in-progress', 'ready', 'dispatched', 'delayed'],
  DELIVERY: ['pending', 'transit', 'attempted', 'delayed', 'delivered'],
};

function listForStage(stageKey, view, q) {
  const today = dates.todayLocal();
  const matches = (p) => {
    const conf = stageStatusOf(p, 'CONFIRMATION');
    const pack = stageStatusOf(p, 'PACKAGING');
    const doc = stageStatusOf(p, 'DOCUMENTATION_DISPATCH');
    const dis = p.dispatchDetails.status || 'PENDING';
    const del = stageStatusOf(p, 'DELIVERY');
    switch (`${stageKey}:${view}`) {
      case 'CONFIRMATION:pending': return p.currentStage === stageKey && conf === 'PENDING';
      case 'CONFIRMATION:active': return conf === 'IN_PROGRESS';
      case 'CONFIRMATION:completed': return conf === 'COMPLETED';
      case 'CONFIRMATION:delayed': return conf === 'DELAYED' || (p.currentStage === stageKey && S.delayInfo(p, today).key !== 'NONE');
      case 'PACKAGING:pending': return p.currentStage === stageKey && pack === 'PENDING';
      case 'PACKAGING:active': return pack === 'IN_PROGRESS';
      case 'PACKAGING:completed': return pack === 'COMPLETED';
      case 'PACKAGING:delayed': return pack === 'DELAYED' || (p.currentStage === stageKey && S.delayInfo(p, today).key !== 'NONE');
      case 'DOCUMENTATION_DISPATCH:awaiting': return p.currentStage === stageKey && doc === 'PENDING';
      case 'DOCUMENTATION_DISPATCH:in-progress': return doc === 'IN_PROGRESS';
      case 'DOCUMENTATION_DISPATCH:ready': return dis === 'READY';
      case 'DOCUMENTATION_DISPATCH:dispatched': return dis === 'COMPLETED';
      case 'DOCUMENTATION_DISPATCH:delayed': return doc === 'DELAYED' || dis === 'DELAYED' || (p.currentStage === stageKey && S.delayInfo(p, today).key !== 'NONE');
      case 'DELIVERY:pending': return p.currentStage === stageKey && del === 'PENDING';
      case 'DELIVERY:transit': return del === 'IN_PROGRESS';
      case 'DELIVERY:attempted': return del === 'ATTEMPTED';
      case 'DELIVERY:delayed': return del === 'DELAYED' || (p.currentStage === stageKey && S.delayInfo(p, today).key !== 'NONE');
      case 'DELIVERY:delivered': return p.currentStage === 'DELIVERED';
      default: return p.currentStage === stageKey;
    }
  };
  const needle = (q || '').trim().toLowerCase();
  const items = [];
  for (const pkg of listAllCache()) {
    if (!matches(pkg)) continue;
    const v = workflowView(pkg, today);
    if (needle) {
      const hay = `${v.packageCode} ${v.projectName} ${v.customerName} ${v.orderReference}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    items.push(v);
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items;
}

// Simple in-request cache to keep Firestore reads low per view call.
let _cacheAt = 0;
let _cache = [];
function listAllCache() {
  return _cache; // populated by loadView(); kept synchronous inside one request
}

/**
 * Workflow list endpoint entry (async data load then view mapping).
 */
async function loadForStage(stageKey, view, q) {
  const valid = (VIEWS[stageKey] || []).includes(view) ? view : allView(stageKey);
  await reloadCache();
  return listForStage(stageKey, valid, q);
}

function allView(stageKey) {
  return ({ CONFIRMATION: 'pending', PACKAGING: 'pending',
    DOCUMENTATION_DISPATCH: 'awaiting', DELIVERY: 'pending' })[stageKey] || 'pending';
}

async function reloadCache() {
  _cache = await listAll();
  _cacheAt = Date.now();
}

/** Detail: workflow view + latest history entries. */
async function detail(code, stageKey) {
  const pkg = await getPackage(code);
  if (!pkg) throw new PackageError(`Package "${code}" was not found`, 404);
  const hist = await ref(code).collection('history').orderBy('timestamp', 'desc').limit(30).get();
  const history = hist.docs.map((d) => {
    const x = d.data() || {};
    return {
      stage: S.STAGES[x.stage] ? S.STAGES[x.stage].label : x.stage,
      previousStatus: S.STATUS[x.previousStatus] ? S.STATUS[x.previousStatus].label : x.previousStatus,
      newStatus: S.STATUS[x.newStatus] ? S.STATUS[x.newStatus].label : x.newStatus,
      updatedBy: x.updatedBy || '',
      timestamp: x.timestamp ? dates.fmtTs(x.timestamp) : '',
      remarks: x.remarks || '',
      action: x.action || '',
      reason: x.reason || '',
    };
  });
  return { package: workflowView(pkg, dates.todayLocal()), history };
}

// ------------------------------------------------------------ public API

/** Public-safe row (fields whitelisted; internal data excluded). */
function publicRow(p, today) {
  const delayed = S.delayInfo(p, today);
  return {
    packageCode: p.packageCode,
    projectName: p.projectName,
    customerName: p.publicCustomer ? p.customerName : null,
    stage: p.currentStage,
    stageLabel: S.STAGES[p.currentStage].label,
    status: p.status,
    statusLabel: p.currentStage === 'DELIVERED' ? 'Delivered' : S.STATUS[p.status].label,
    badge: p.currentStage === 'DELIVERED' ? 'delivered' : S.STATUS[p.status].badge,
    progress: S.STAGES[p.currentStage].progress,
    expectedDelivery: p.expectedDelivery || '',
    delayKey: delayed.key,
    delayDetail: delayed.detail,
    updatedAt: p.updatedAt ? p.updatedAt.toMillis() : 0,
  };
}

function publicSummary(today) {
  const c = { total: 0, awaitingConfirmation: 0, inPackaging: 0, awaitingDocDispatch: 0, inDelivery: 0, delivered: 0, delayed: 0 };
  for (const p of listAllCache()) {
    c.total += 1;
    if (p.currentStage === 'CONFIRMATION') c.awaitingConfirmation += 1;
    if (p.currentStage === 'PACKAGING') c.inPackaging += 1;
    if (p.currentStage === 'DOCUMENTATION_DISPATCH') c.awaitingDocDispatch += 1;
    if (p.currentStage === 'DELIVERY') c.inDelivery += 1;
    if (p.currentStage === 'DELIVERED') c.delivered += 1;
    if (S.isDelayed(p, today)) c.delayed += 1;
  }
  return c;
}

async function publicData(filters = {}) {
  const today = dates.todayLocal();
  await reloadCache();
  const stage = S.STAGES[filters.stage] ? filters.stage : null;
  const q = (filters.q || '').trim().toLowerCase();
  let items = listAllCache().map((p) => publicRow(p, today));
  items = items.filter((r) => {
    if (stage && r.stage !== stage) return false;
    if (filters.status && r.status !== filters.status) return false;
    if (q && !`${r.packageCode} ${r.projectName} ${r.customerName || ''}`.toLowerCase().includes(q)) return false;
    if (filters.from && !(r.expectedDelivery && r.expectedDelivery >= filters.from)) return false;
    if (filters.to && !(r.expectedDelivery && r.expectedDelivery <= filters.to)) return false;
    return true;
  });
  const dir = filters.dir === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    if (filters.sort === 'delivery') {
      return a.expectedDelivery && b.expectedDelivery ? a.expectedDelivery.localeCompare(b.expectedDelivery) * dir
        : (a.expectedDelivery ? -1 : 1) * dir * -1;
    }
    return (a.updatedAt - b.updatedAt) * dir * -1; // newest first by default
  });
  return { summary: publicSummary(today), items };
}

/** Admin summary numbers (employees count added by the admin route). */
function adminSummary(today) {
  return publicSummary(today);
}

module.exports = {
  PackageError, createPackage, applyAction, getPackage, listAll, loadForStage,
  detail, publicData, publicSummary, workflowView, VIEWS, listForStage, reloadCache, adminSummary,
};
