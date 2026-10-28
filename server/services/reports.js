'use strict';

/**
 * Reports & bottleneck analytics. Everything is computed from real Firestore
 * data (package timestamps + history events). When a metric has no data in the
 * selected range, it reports "insufficient data" instead of inventing numbers.
 */
const admin = require('firebase-admin');
const fb = require('../config/firebase');
const { CsvBuilder, cleanToken } = require('../lib/csv');
const S = require('../lib/stages');
const packages_ = require('./packages');

const STAGE_LABELS = {
  CONFIRMATION: 'Confirmation',
  PACKAGING: 'Packaging',
  DOCUMENTATION_DISPATCH: 'Documentation/Dispatch',
  DELIVERY: 'Delivery',
};

function avg(values) {
  const xs = values.filter((v) => typeof v === 'number' && v >= 0);
  if (!xs.length) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

function inRange(ts, from, to) {
  if (!ts || typeof ts.toMillis !== 'function') return false;
  const ms = ts.toMillis();
  const f = Date.parse(from + 'T00:00:00');
  const t = Date.parse(to + 'T00:00:00');
  return ms >= f && ms < t;
}

/** Row-level duration helper: days between two timestamps (null-safe). */
function dur(a, b) {
  if (!a || !b || typeof a.toMillis !== 'function' || typeof b.toMillis !== 'function') return null;
  return (b.toMillis() - a.toMillis()) / 86400000;
}

/**
 * Main report builder. rangeKind: this-week | last-week | this-month |
 * last-month | custom.
 */
async function buildReport({ rangeKind, fromIso, toIso }) {
  const dates = require('../lib/dates');
  const range = dates.rangeFor(rangeKind, fromIso, toIso, dates.todayLocal());
  const packages = await packages_.listAll();
  const today = dates.todayLocal();

  const created = packages.filter((p) => inRange(p.createdAt, range.from, range.to));
  const deliveredInRange = packages.filter((p) =>
    p.currentStage === 'DELIVERED' && inRange(p.actualDelivery, range.from, range.to));
  const active = packages.filter((p) => p.currentStage !== 'DELIVERED');
  const delayed = packages.filter((p) => S.isDelayed(p, today));

  const picked = unionById(created, deliveredInRange);

  // ---- average completion time -------------------------------------------------
  const completionDays = deliveredInRange
    .map((p) => dur(p.createdAt, p.actualDelivery))
    .filter((x) => x != null);
  const avgCompletion = avg(completionDays);

  // ---- per-package stage durations ---------------------------------------------
  const stageDurations = { CONFIRMATION: [], PACKAGING: [], DOCUMENTATION_DISPATCH: [], DELIVERY: [] };
  for (const p of picked) {
    const c = p.confirmationDetails, pk = p.packagingDetails;
    const doc = p.documentationDetails, dsp = p.dispatchDetails, dl = p.deliveryDetails;
    if (c && c.startedAt && c.completedAt) stageDurations.CONFIRMATION.push(dur(c.startedAt, c.completedAt));
    if (pk && pk.startedAt && pk.completedAt) stageDurations.PACKAGING.push(dur(pk.startedAt, pk.completedAt));
    if (doc && (doc.startedAt || doc.verifiedAt) && dsp && dsp.completedAt) {
      stageDurations.DOCUMENTATION_DISPATCH.push(dur(doc.startedAt || doc.verifiedAt, dsp.completedAt));
    }
    if (dl && dl.startedAt && dl.actualDelivery) stageDurations.DELIVERY.push(dur(dl.startedAt, dl.actualDelivery));
  }

  // ---- delay history via a single collectionGroup query --------------------------
  const { delayEventsByStage, reasons } = await loadDelayEvents();

  // ---- packages currently waiting per stage -------------------------------------
  const awaiting = { CONFIRMATION: 0, PACKAGING: 0, DOCUMENTATION_DISPATCH: 0, DELIVERY: 0 };
  for (const p of packages) {
    if (S.STAGES[p.currentStage] && awaiting[p.currentStage] !== undefined) awaiting[p.currentStage] += 1;
  }

  const stages = S.ORDER.filter((k) => k !== 'DELIVERED').map((key) => ({
    stage: key,
    label: STAGE_LABELS[key],
    avgDays: avg(stageDurations[key]),
    delayed: delayEventsByStage[key] || 0,
    awaiting: awaiting[key],
  }));
  const measuredStages = stages.filter((row) => row.avgDays != null);
  const slowest = measuredStages.length
    ? measuredStages.reduce((a, b) => (b.avgDays > a.avgDays ? b : a))
    : null;

  // ---- weekly/monthly trend -------------------------------------------------------
  const cube = buildTrend(created.map((p) => p.createdAt), deliveredInRange.map((p) => p.actualDelivery), range);

  const insufficient = [];
  if (!created.length) insufficient.push('No packages were created in this period.');
  if (!deliveredInRange.length) insufficient.push('No packages were delivered in this period.');
  if (avgCompletion == null) insufficient.push('Average completion time is unavailable (no delivered package in the period has full timestamps).');
  if (!measuredStages.length) insufficient.push('Stage durations are unavailable (no stage has both start and completion timestamps yet).');
  if (!Object.keys(reasons).length) insufficient.push('No delay reasons have been recorded yet.');

  return {
    rangeLabel: dates.humanRange(range),
    rangeKind,
    from: range.from,
    to: range.to,
    metrics: {
      created: created.length,
      delivered: deliveredInRange.length,
      active: active.length,
      delayed: delayed.length,
      avgCompletionDays: avgCompletion,
      slowestStage: slowest ? slowest.label : null,
    },
    stages,
    topDelayReasons: topEntries(reasons, 8),
    trend: cube,
    insufficient,
  };
}

function unionById(a, b) {
  const seen = new Set();
  const out = [];
  for (const p of a.concat(b)) {
    if (!seen.has(p.packageCode)) { seen.add(p.packageCode); out.push(p); }
  }
  return out;
}

function topEntries(map, n) {
  return Object.entries(map)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

/** history events with newStatus == DELAYED grouped by stage + reason. */
async function loadDelayEvents() {
  const byStage = { CONFIRMATION: 0, PACKAGING: 0, DOCUMENTATION_DISPATCH: 0, DELIVERY: 0 };
  const reasons = {};
  try {
    const snap = await fb.firestore().collectionGroup('history').where('newStatus', '==', 'DELAYED').get();
    const seen = new Set();
    snap.docs.forEach((d) => {
      const x = d.data() || {};
      const pkgId = d.ref.parent.parent ? d.ref.parent.parent.id : null;
      const key = (pkgId || '') + '|' + (x.stage || '');
      if (seen.has(key)) return;
      seen.add(key);
      if (byStage[x.stage] !== undefined) byStage[x.stage] += 1;
      const r = (x.reason || x.remarks || 'Unspecified').slice(0, 120);
      reasons[r] = (reasons[r] || 0) + 1;
    });
  } catch (err) {
    console.warn('[blindspot] delay history query failed:', err.message);
  }
  return { delayEventsByStage: byStage, reasons };
}

/** Trend buckets: weekly by default, monthly for wide spans (>26 weeks). */
function buildTrend(createdTsList, deliveredTsList, range) {
  const dates = require('../lib/dates');
  const fromDate = new Date(range.from + 'T00:00:00');
  const toDate = new Date(range.to + 'T00:00:00');
  const spanDays = Math.max(1, Math.round((toDate - fromDate) / 86400000));
  const useMonths = spanDays > 190;

  const buckets = [];
  if (useMonths) {
    const cursor = new Date(fromDate.getTime());
    cursor.setDate(1);
    while (cursor < toDate) {
      const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      buckets.push({ from: new Date(cursor.getTime()), to: next, label: cursor.toISOString().slice(0, 7) });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(fromDate.getTime());
    // start at ISO Monday
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
    while (cursor < toDate) {
      const next = new Date(cursor.getTime() + 7 * 86400000);
      buckets.push({ from: new Date(cursor.getTime()), to: next, label: dates.isoWeek(cursor, false).label });
      cursor.setTime(next.getTime());
    }
  }

  const created = buckets.map(() => 0);
  const delivered = buckets.map(() => 0);
  const bump = (tsList, arr) => {
    for (const ts of tsList) {
      if (!ts || typeof ts.toMillis !== 'function') continue;
      const ms = ts.toMillis();
      buckets.forEach((b, i) => { if (ms >= b.from.getTime() && ms < b.to.getTime()) arr[i] += 1; });
    }
  };
  bump(createdTsList, created);
  bump(deliveredTsList, delivered);

  return { labels: buckets.map((b) => b.label), created, delivered };
}

/**
 * CSV export for a report range: one row per package created or delivered in
 * the range. Employee emails/credentials are never included.
 */
async function exportCsv({ rangeKind, fromIso, toIso }) {
  const dates = require('../lib/dates');
  const range = dates.rangeFor(rangeKind, fromIso, toIso, dates.todayLocal());
  const packages = await packages_.listAll();
  const rows = unionById(
    packages.filter((p) => inRange(p.createdAt, range.from, range.to)),
    packages.filter((p) => p.currentStage === 'DELIVERED' && inRange(p.actualDelivery, range.from, range.to)),
  );
  const csv = new CsvBuilder();
  csv.row(['Package ID', 'Project', 'Customer', 'Stage', 'Status',
    'Created', 'Confirmation start', 'Confirmation complete', 'Packaging start', 'Packaging complete',
    'Doc verified', 'Dispatch date', 'Delivered', 'Expected delivery',
    'Actual delivery', 'Delay reason', 'Delay status']);
  for (const p of rows) {
    const doc = p.documentationDetails || {};
    csv.row([
      p.packageCode, p.projectName, p.customerName,
      STAGE_LABELS[p.currentStage] || p.currentStage,
      (S.STATUS[p.status] || {}).label || p.status,
      dates.fmtTs(p.createdAt),
      dates.fmtTs(p.confirmationDetails.startedAt),
      dates.fmtTs(p.confirmationDetails.completedAt),
      dates.fmtTs(p.packagingDetails.startedAt),
      dates.fmtTs(p.packagingDetails.completedAt),
      doc.verificationStatus === 'VERIFIED' ? dates.fmtTs(doc.verifiedAt) : '',
      p.dispatchDetails.dispatchDate || '',
      p.currentStage === 'DELIVERED' ? dates.fmtTs(p.deliveryDetails.actualDelivery) : '',
      p.expectedDelivery || '',
      p.currentStage === 'DELIVERED' ? dates.fmtTs(p.actualDelivery) : '',
      p.delayReason || '',
      S.isDelayed(p, dates.todayLocal()) ? 'Delayed' : 'On schedule',
    ]);
  }
  return { csv: csv.build(), rows: rows.length, range: rangeKind };
}

module.exports = { buildReport, exportCsv, cleanToken };
