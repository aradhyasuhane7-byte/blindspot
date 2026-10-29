'use strict';

/**
 * Unit tests for the pure workflow-rules library (no Firebase needed):
 *   npm test
 * They cover: stage transition guards, business-rule 2/3/4/5 checks,
 * delay evaluation and CSV escaping.
 */
const assert = require('node:assert');
const S = require('../server/lib/stages');
const csv = require('../server/lib/csv');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok  -', name);
  } catch (err) {
    console.error('FAIL-', name, '\n    ', err.message);
    process.exitCode = 1;
  }
}

const TODAY = '2026-10-28';

// ---------------------------------------------------------------- transitions
test('start is only allowed from PENDING', () => {
  assert.equal(S.canApply('start', 'PENDING'), true);
  assert.equal(S.canApply('start', 'IN_PROGRESS'), false);
  assert.equal(S.canApply('start', 'COMPLETED'), false);
  assert.equal(S.canApply('start', 'DELAYED'), false);
});

test('complete allowed from PENDING or IN_PROGRESS, not from DELAYED', () => {
  assert.equal(S.canApply('complete', 'PENDING'), true);
  assert.equal(S.canApply('complete', 'IN_PROGRESS'), true);
  assert.equal(S.canApply('complete', 'DELAYED'), false);
  assert.equal(S.canApply('complete', 'COMPLETED'), false);
});

test('delay allowed from active statuses only', () => {
  assert.equal(S.canApply('delay', 'PENDING'), true);
  assert.equal(S.canApply('delay', 'IN_PROGRESS'), true);
  assert.equal(S.canApply('delay', 'ATTEMPTED'), true);
  assert.equal(S.canApply('delay', 'COMPLETED'), false);
});

test('remarks/record-issue allowed on any active status', () => {
  assert.equal(S.canApply('remarks', 'PENDING'), true);
  assert.equal(S.canApply('remarks', 'DELAYED'), true);
  assert.equal(S.canApply('remarks', 'COMPLETED'), false);
});

// -------------------------------------------------- cross-stage business rules
test('packaging requires completed confirmation', () => {
  const p = { currentStage: 'PACKAGING', status: 'PENDING', confirmationDetails: { status: 'IN_PROGRESS' } };
  assert.throws(() => S.assertConfirmComplete(p), /Confirmation must be completed/);
  p.confirmationDetails.status = 'COMPLETED';
  assert.doesNotThrow(() => S.assertConfirmComplete(p));
});

test('delivery requires completed dispatch', () => {
  const p = { currentStage: 'DELIVERY', status: 'PENDING', dispatchDetails: { status: 'PENDING' } };
  assert.throws(() => S.assertDispatchComplete(p), /dispatch\/handover/);
  p.dispatchDetails = { status: 'COMPLETED', transporter: 'T', trackingNumber: 'X', dispatchDate: '2026-10-20' };
  assert.doesNotThrow(() => S.assertDispatchComplete(p));
});

test('dispatch completion requires verified docs + dispatch fields', () => {
  const p = {
    currentStage: 'DOCUMENTATION_DISPATCH',
    documentationDetails: { invoiceNumber: 'INV-1', shippingDocRef: 'DOC-1', verificationStatus: 'PENDING' },
    dispatchDetails: { transporter: 'T', trackingNumber: 'X', dispatchDate: '2026-10-20' },
  };
  assert.throws(() => S.assertDocDataComplete(p), /verified documentation/i);
  p.documentationDetails.verificationStatus = 'VERIFIED';
  assert.doesNotThrow(() => S.assertDocDataComplete(p));
  delete p.dispatchDetails.trackingNumber;
  assert.throws(() => S.assertDocDataComplete(p), /tracking number/i);
});

test('stage mismatch is rejected (no skipping stages)', () => {
  const p = { currentStage: 'CONFIRMATION' };
  assert.throws(() => S.assertStageAllows(p, 'PACKAGING'), /only available while the package/);
  assert.doesNotThrow(() => S.assertStageAllows(p, 'CONFIRMATION'));
});

// ------------------------------------------------------------------- delays
test('delivered packages are never delayed', () => {
  const r = S.delayInfo({ currentStage: 'DELIVERED', status: 'COMPLETED', expectedDelivery: '2026-01-01' }, TODAY);
  assert.equal(r.key, 'NONE');
});

test('expected delivery passing marks overdue - not "not finished"', () => {
  const p = { currentStage: 'DELIVERY', status: 'IN_PROGRESS', expectedDelivery: '2026-10-20' };
  const r = S.delayInfo(p, TODAY);
  assert.equal(r.key, 'OVERDUE');
  assert.equal(r.overdueDays, 8);
});

test('recorded delay takes priority', () => {
  const p = { currentStage: 'PACKAGING', status: 'DELAYED', delayReason: 'Missing materials', expectedDelivery: '2026-10-20' };
  const r = S.delayInfo(p, TODAY);
  assert.equal(r.key, 'RECORDED');
  assert.equal(r.detail, 'Missing materials');
});

test('future expected date = on schedule', () => {
  const p = { currentStage: 'CONFIRMATION', status: 'PENDING', expectedDelivery: '2026-11-15' };
  assert.equal(S.isDelayed(p, TODAY), false);
  const none = S.delayInfo({ currentStage: 'CONFIRMATION', status: 'PENDING', expectedDelivery: null }, TODAY);
  assert.equal(none.key, 'NONE');
});

// ------------------------------------------- stage deadlines (WP1 delay intel)
test('isoPlusDays adds whole days to an ISO date', () => {
  assert.equal(S.isoPlusDays('2026-10-28', 2), '2026-10-30');
  assert.equal(S.isoPlusDays('2026-10-31', 1), '2026-11-01'); // month rollover
  assert.equal(S.isoPlusDays('2026-12-30', 5), '2027-01-04'); // year rollover
  assert.equal(S.isoPlusDays('2026-10-28', 0), '2026-10-28');
});

test('fmtTsToIso normalizes timestamps and dates to yyyy-MM-dd', () => {
  assert.equal(S.fmtTsToIso('2026-10-28T09:30:00.000Z'), '2026-10-28');
  assert.equal(S.fmtTsToIso(new Date(Date.UTC(2026, 9, 28, 12))), '2026-10-28');
  assert.equal(S.fmtTsToIso(null), null);
  // Firestore Timestamp duck-typing
  assert.equal(S.fmtTsToIso({ toMillis: () => Date.UTC(2026, 9, 28, 15) }), '2026-10-28');
});

test('every stage has a planned target in days', () => {
  for (const st of ['CONFIRMATION', 'PACKAGING', 'DOCUMENTATION_DISPATCH', 'DELIVERY']) {
    assert.equal(typeof S.TARGET_DAYS[st], 'number');
    assert.ok(S.TARGET_DAYS[st] > 0);
  }
});

test('delay taxonomy has exactly the six vision codes', () => {
  assert.deepEqual(Object.keys(S.DELAY_REASONS).sort(), [
    'DOCUMENTATION_ERROR', 'MATERIAL_SHORTAGE', 'MISSING_INFORMATION',
    'OTHER', 'PACKAGING_ISSUE', 'TRANSPORTER_DELAY',
  ]);
});

test('stageDeadlineInfo: planned date 2 days past = 2 days overdue', () => {
  const p = {
    currentStage: 'PACKAGING',
    packagingDetails: { status: 'IN_PROGRESS', startedAt: '2026-10-20T09:00:00.000Z', plannedCompletion: '2026-10-26' },
  };
  const r = S.stageDeadlineInfo(p, 'PACKAGING', TODAY);
  assert.equal(r.planned, '2026-10-26');
  assert.equal(r.overdueDays, 2);
  assert.equal(r.source, 'stored');
});

test('stageDeadlineInfo: derived from startedAt when no stored plan (legacy data)', () => {
  const p = {
    currentStage: 'CONFIRMATION',
    confirmationDetails: { status: 'IN_PROGRESS', startedAt: '2026-10-20T09:00:00.000Z' },
  };
  const r = S.stageDeadlineInfo(p, 'CONFIRMATION', TODAY); // CONFIRMATION target = 2 days
  assert.equal(r.planned, '2026-10-22');
  assert.equal(r.overdueDays, 6);
  assert.equal(r.source, 'derived');
});

test('stageDeadlineInfo: no plan and never started = nothing to report', () => {
  const p = { currentStage: 'PACKAGING', packagingDetails: { status: 'PENDING' } };
  const r = S.stageDeadlineInfo(p, 'PACKAGING', TODAY);
  assert.equal(r.planned, null);
  assert.equal(r.overdueDays, 0);
});

test('stageDeadlineInfo: completed stages and delivered packages are exempt', () => {
  const done = { currentStage: 'DOCUMENTATION_DISPATCH', documentationDetails: { status: 'COMPLETED', plannedCompletion: '2026-10-01' } };
  assert.equal(S.stageDeadlineInfo(done, 'DOCUMENTATION_DISPATCH', TODAY).planned, null);
  const delivered = { currentStage: 'DELIVERED', deliveryDetails: { status: 'IN_PROGRESS', plannedCompletion: '2026-10-01' } };
  assert.equal(S.stageDeadlineInfo(delivered, 'DELIVERY', TODAY).planned, null);
});

// ---------------------------------------------------------------- CSV safety
test('csv escapes commas, quotes and newlines', () => {
  assert.equal(csv.escape('plain'), 'plain');
  assert.equal(csv.escape('a,b'), '"a,b"');
  assert.equal(csv.escape('say "hi"'), '"say ""hi"""');
  assert.equal(csv.escape('line\nbreak'), '"line\nbreak"');
  assert.equal(csv.escape('=SUM(A1)'), '"=SUM(A1)"');
});

test('csv builder produces rows', () => {
  const out = new csv.CsvBuilder().row(['ID', 'note']).row(['PK-1', 'a,b']).build();
  assert.equal(out, 'ID,note\nPK-1,"a,b"\n');
});

// ---------------------------------------------------------------- stage map
test('progress increases per stage', () => {
  assert.ok(S.STAGES.CONFIRMATION.progress < S.STAGES.PACKAGING.progress);
  assert.ok(S.STAGES.PACKAGING.progress < S.STAGES.DOCUMENTATION_DISPATCH.progress);
  assert.ok(S.STAGES.DOCUMENTATION_DISPATCH.progress < S.STAGES.DELIVERY.progress);
  assert.equal(S.STAGES.DELIVERED.progress, 100);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
