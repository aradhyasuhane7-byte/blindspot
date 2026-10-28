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
