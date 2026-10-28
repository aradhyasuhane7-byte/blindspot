'use strict';

/**
 * Demo seeding: five demo employees (one per role) + a package portfolio that
 * covers EVERY stage, view and delay scenario so all dashboards and reports
 * show meaningful, coherent data with realistic timestamps and audit history.
 *
 * Usage:
 *   - automatic: set BLINDSPOT_AUTO_SEED_DEMO=true in .env (done for you) and
 *     start the server once Firebase Admin credentials are configured;
 *   - manual:    npm run seed:demo            (skips existing)
 *                npm run seed:demo -- --force (overwrites packages)
 */
const admin = require('firebase-admin');
const fb = require('../config/firebase');
const employeesService = require('./employees');

const DEMO_PASSWORD = 'demo1234';

const DEMO_EMPLOYEES = [
  { name: 'Demo Admin', email: 'admin@blindspot.demo', role: 'ADMIN' },
  { name: 'Cora Confirm', email: 'confirm@blindspot.demo', role: 'CONFIRM' },
  { name: 'Pat Packaging', email: 'pack@blindspot.demo', role: 'PACK' },
  { name: 'Diana Docs', email: 'doc@blindspot.demo', role: 'DOC' },
  { name: 'Dean Delivery', email: 'del@blindspot.demo', role: 'DEL' },
];

const DAY = 86400000;

/** Timestamp N days ago (with a fixed time-of-day for tidy CSVs). */
function ts(daysAgo, hour = 9) {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 30, 0, 0);
  return admin.firestore.Timestamp.fromDate(d);
}

/** ISO date N days in the future from today (negative = past). */
function iso(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * DAY);
  return d.toISOString().slice(0, 10);
}

function baseDetails(expectedDelivery) {
  return {
    confirmationDetails: { status: 'PENDING', confirmDate: null, startedAt: null, completedAt: null, remarks: null, missingInfo: null, issues: [] },
    packagingDetails: { status: 'PENDING', startedAt: null, completedAt: null, remarks: null, delayReason: null, issues: [] },
    documentationDetails: { status: 'PENDING', startedAt: null, invoiceNumber: null, shippingDocRef: null, verificationStatus: 'PENDING', verifiedAt: null, remarks: null, issues: [] },
    dispatchDetails: { status: 'PENDING', transporter: null, trackingNumber: null, dispatchDate: null, completedAt: null, delayReason: null, remarks: null },
    deliveryDetails: { status: 'PENDING', startedAt: null, expectedDelivery: expectedDelivery || null, actualDelivery: null, attempts: 0, delayReason: null, remarks: null, issues: [] },
  };
}

/**
 * Every demo scenario, stage by stage. `hist` produces audit events matching
 * the timeline. Employee uids are resolved after accounts are created.
 */
const SCENARIOS = [
  {
    code: 'PKG-1001', project: 'Harbor Bridge Substation', customer: 'Voltis Energy AG',
    publicCustomer: true, orderRef: 'PO-88120', details: 'Switchgear crates x4, panel assembly',
    expected: iso(3), createdDays: 1, stage: 'CONFIRMATION', status: 'PENDING', updatedAt: ts(0, 10),
    extra: (d) => { d.confirmationDetails.confirmDate = iso(0); },
    hist: [['CONFIRMATION', 'N/A', 'PENDING', 'created', 'Package created at the Confirmation stage (demo)', 'create', null, 1]],
  },
  {
    code: 'PKG-1002', project: 'Riverside Warehouse Fit-out', customer: 'Brightbreak Logistics',
    publicCustomer: false, orderRef: 'PO-88210', details: 'Racking modules, 12 pallets with consignment notes',
    expected: iso(10), createdDays: 2, stage: 'CONFIRMATION', status: 'PENDING', updatedAt: ts(1, 15),
    extra: (d) => { d.confirmationDetails.confirmDate = iso(-1); },
    hist: [['CONFIRMATION', 'N/A', 'PENDING', 'created', 'Package created at the Confirmation stage (demo)', 'create', null, 2]],
  },
  {
    code: 'PKG-1003', project: 'Delta Logistics Twins', customer: 'Meridian Freight Group',
    publicCustomer: true, orderRef: 'PO-88340', details: 'Two identical control cabinets with serials',
    expected: iso(7), createdDays: 4, stage: 'CONFIRMATION', status: 'IN_PROGRESS', updatedAt: ts(0, 9),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-3);
      d.confirmationDetails.startedAt = ts(1, 10);
      d.confirmationDetails.remarks = 'Checking cabinet BOM against the revision C drawings';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 4],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 1],
    ],
  },
  {
    code: 'PKG-1004', project: 'Aurora Textile Line Parts', customer: 'Helix Manufacturing',
    publicCustomer: false, orderRef: 'PO-88477', details: 'Spare parts kit for line 4 rebuild',
    expected: iso(-2), createdDays: 8, stage: 'CONFIRMATION', status: 'DELAYED', updatedAt: ts(0, 8),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-7);
      d.confirmationDetails.startedAt = ts(3, 11);
      d.confirmationDetails.delayReason = 'Purchase order amendment pending customer approval';
      d.delayReason = 'Purchase order amendment pending customer approval';
      d.confirmationDetails.issues.push({ note: 'Delayed: Purchase order amendment pending customer approval', by: 'Cora Confirm', at: ts(0, 8) });
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 8],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 3],
      ['CONFIRMATION', 'IN_PROGRESS', 'DELAYED', 'delay', 'Delay recorded - Purchase order amendment pending customer approval', 'delay', 'Purchase order amendment pending customer approval', 0],
    ],
  },
  {
    code: 'PKG-1005', project: 'Crosswind Turbine Spares', customer: 'Voltis Energy AG',
    publicCustomer: true, orderRef: 'PO-88512', details: 'Blade sensor kits, ESD packaging required',
    expected: iso(5), createdDays: 6, stage: 'PACKAGING', status: 'PENDING', updatedAt: ts(2, 16),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-4);
      d.confirmationDetails.startedAt = ts(3, 9);
      d.confirmationDetails.completedAt = ts(2, 16);
      d.confirmationDetails.status = 'COMPLETED';
      d.confirmationDetails.remarks = 'Order details confirmed with the customer by email';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 6],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 3],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 2],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 2],
    ],
  },
  {
    code: 'PKG-1006', project: 'Copperline Cable Reels', customer: 'Nordic Grid Atelier',
    publicCustomer: false, orderRef: 'PO-88590', details: 'Cable reels R-10 x6, moisture retention wraps',
    expected: iso(6), createdDays: 9, stage: 'PACKAGING', status: 'IN_PROGRESS', updatedAt: ts(0, 11),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-8);
      d.confirmationDetails.startedAt = ts(6, 10);
      d.confirmationDetails.completedAt = ts(4, 15);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(1, 9);
      d.packagingDetails.status = 'IN_PROGRESS';
      d.packagingDetails.remarks = 'Crate foam reorder - using intermediate crate design instead';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 9],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 6],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 4],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 4],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 1],
    ],
  },
  {
    code: 'PKG-1007', project: 'Solaris Inverter Batch', customer: 'Photovoltaica Ltd',
    publicCustomer: true, orderRef: 'PO-88633', details: 'Inverters x20, protective foam lining required',
    expected: iso(-1), createdDays: 12, stage: 'PACKAGING', status: 'DELAYED', updatedAt: ts(0, 14),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-10);
      d.confirmationDetails.startedAt = ts(9, 9);
      d.confirmationDetails.completedAt = ts(7, 13);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(4, 9);
      d.packagingDetails.status = 'DELAYED';
      d.packagingDetails.delayReason = 'Missing protective foam - supplier ETA slipped twice';
      d.delayReason = 'Missing protective foam - supplier ETA slipped twice';
      d.packagingDetails.issues.push({ note: 'Missing materials: foam lining backordered', by: 'Pat Packaging', at: ts(2, 10) });
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 12],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 9],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 7],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 7],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 4],
      ['PACKAGING', 'IN_PROGRESS', 'DELAYED', 'delay', 'Delay recorded - Missing protective foam', 'delay', 'Missing protective foam - supplier ETA slipped twice', 0],
    ],
  },
  {
    code: 'PKG-1008', project: 'Ironclad Tooling Set', customer: 'Helix Manufacturing',
    publicCustomer: false, orderRef: 'PO-88711', details: 'Press tooling, fearsome weight: 3.1t total',
    expected: iso(4), createdDays: 14, stage: 'DOCUMENTATION_DISPATCH', status: 'PENDING', updatedAt: ts(1, 13),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-12);
      d.confirmationDetails.startedAt = ts(10, 9);
      d.confirmationDetails.completedAt = ts(8, 12);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(6, 8);
      d.packagingDetails.completedAt = ts(1, 13);
      d.packagingDetails.status = 'COMPLETED';
      d.packagingDetails.remarks = 'Custom pallet + metal strapping, load plan attached to system map';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 14],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 10],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 8],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 8],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 6],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 1],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 1],
    ],
  },
  {
    code: 'PKG-1009', project: 'Neonworks LED Modules', customer: 'Lumen Wholesale BV',
    publicCustomer: true, orderRef: 'PO-88795', details: 'LED driver modules, 48 boxes, hazmat-free',
    expected: iso(8), createdDays: 16, stage: 'DOCUMENTATION_DISPATCH', status: 'IN_PROGRESS', updatedAt: ts(0, 12),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-14);
      d.confirmationDetails.startedAt = ts(12, 9);
      d.confirmationDetails.completedAt = ts(11, 11);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(9, 8);
      d.packagingDetails.completedAt = ts(5, 14);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(1, 9);
      d.documentationDetails.status = 'IN_PROGRESS';
      d.documentationDetails.invoiceNumber = 'INV-7741';
      d.documentationDetails.shippingDocRef = 'SH-2281';
      d.documentationDetails.remarks = 'Awaiting customs annex PDF from warehouse team';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 16],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 12],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 11],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 11],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 9],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 5],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 5],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 1],
    ],
  },
  {
    code: 'PKG-1010', project: 'Steelhearts Valve Parcel', customer: 'Fluid Dynamics SA',
    publicCustomer: true, orderRef: 'PO-88841', details: 'Industrial valves x8, requires phytosanitary cert',
    expected: iso(4), createdDays: 18, stage: 'DOCUMENTATION_DISPATCH', status: 'IN_PROGRESS', updatedAt: ts(1, 10),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-16);
      d.confirmationDetails.startedAt = ts(14, 9);
      d.confirmationDetails.completedAt = ts(12, 15);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(10, 8);
      d.packagingDetails.completedAt = ts(6, 12);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(4, 8);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7802';
      d.documentationDetails.shippingDocRef = 'SH-2290';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(1, 10);
      d.dispatchDetails.status = 'READY';
      d.dispatchDetails.remarks = 'Carrier booking confirmed for Thursday 08:00';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 18],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 14],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 12],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 12],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 10],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 6],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 6],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 4],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 1],
    ],
  },
  {
    code: 'PKG-1011', project: 'Granite Parts Order 14', customer: 'Meridian Freight Group',
    publicCustomer: false, orderRef: 'PO-88902', details: 'Machine parts, 2 crates, liftgate booking',
    expected: iso(5), createdDays: 21, stage: 'DELIVERY', status: 'PENDING', updatedAt: ts(2, 15),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-19);
      d.confirmationDetails.startedAt = ts(17, 9);
      d.confirmationDetails.completedAt = ts(15, 12);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(12, 8);
      d.packagingDetails.completedAt = ts(7, 15);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(5, 8);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7833';
      d.documentationDetails.shippingDocRef = 'SH-2304';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(3, 10);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'NordFleet Logistics';
      d.dispatchDetails.trackingNumber = 'TRK-90213';
      d.dispatchDetails.dispatchDate = iso(-3);
      d.dispatchDetails.completedAt = ts(2, 15);
      d.dispatchDetails.remarks = 'Handover completed at dock 4, signed manifest';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 21],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 17],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 15],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 15],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 12],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 7],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 7],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 5],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 3],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 2],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 2],
    ],
  },
  {
    code: 'PKG-1012', project: 'Evergreen Asphalt Batch', customer: 'Roadworks United',
    publicCustomer: true, orderRef: 'PO-89001', details: 'Additive drums x10 with digests (pallet 1-2)',
    expected: iso(2), createdDays: 24, stage: 'DELIVERY', status: 'IN_PROGRESS', updatedAt: ts(0, 9),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-22);
      d.confirmationDetails.startedAt = ts(20, 9);
      d.confirmationDetails.completedAt = ts(18, 11);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(15, 8);
      d.packagingDetails.completedAt = ts(10, 14);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(8, 8);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7865';
      d.documentationDetails.shippingDocRef = 'SH-2318';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(6, 9);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'NordFleet Logistics';
      d.dispatchDetails.trackingNumber = 'TRK-90380';
      d.dispatchDetails.dispatchDate = iso(-6);
      d.dispatchDetails.completedAt = ts(5, 14);
      d.deliveryDetails.startedAt = ts(1, 8);
      d.deliveryDetails.status = 'IN_PROGRESS';
      d.deliveryDetails.remarks = 'Arrives via ring road, no toll hold-ups expected';
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 24],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 20],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 18],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 18],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 15],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 10],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 10],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 8],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 6],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 5],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 5],
      ['DELIVERY', 'PENDING', 'IN_PROGRESS', 'start', 'Delivery in transit (demo)', 'start', null, 1],
    ],
  },
  {
    code: 'PKG-1013', project: 'Falcon Control Panels', customer: 'Aerial Systems KiteCo',
    publicCustomer: false, orderRef: 'PO-89120', details: 'Control panels x3, glass panels wrapped separately',
    expected: iso(4), createdDays: 20, stage: 'DELIVERY', status: 'ATTEMPTED', updatedAt: ts(0, 16),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-18);
      d.confirmationDetails.startedAt = ts(15, 9);
      d.confirmationDetails.completedAt = ts(13, 14);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(11, 8);
      d.packagingDetails.completedAt = ts(7, 12);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(5, 9);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7890';
      d.documentationDetails.shippingDocRef = 'SH-2331';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(4, 11);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'Ceylon Carriers OÜ';
      d.dispatchDetails.trackingNumber = 'TRK-90455';
      d.dispatchDetails.dispatchDate = iso(-4);
      d.dispatchDetails.completedAt = ts(3, 13);
      d.deliveryDetails.startedAt = ts(2, 9);
      d.deliveryDetails.status = 'ATTEMPTED';
      d.deliveryDetails.attempts = 1;
      d.deliveryDetails.issues.push({ note: 'Delivery attempt: recipient absent at drop point', by: 'Dean Delivery', at: ts(0, 16) });
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 20],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 15],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 13],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 13],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 11],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 7],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 7],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 5],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 4],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 3],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 3],
      ['DELIVERY', 'PENDING', 'IN_PROGRESS', 'start', 'Delivery in transit (demo)', 'start', null, 2],
      ['DELIVERY', 'IN_PROGRESS', 'ATTEMPTED', 'attempt', 'Delivery attempt recorded (demo)', 'attempt', null, 0],
    ],
  },
  {
    code: 'PKG-1014', project: 'Highline Rail Sensors', customer: 'Transit Infrastructure Oy',
    publicCustomer: true, orderRef: 'PO-89201', details: 'Track sensors x40, anti-static bags required',
    expected: iso(7), createdDays: 17, stage: 'DELIVERY', status: 'DELAYED', updatedAt: ts(0, 10),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-15);
      d.confirmationDetails.startedAt = ts(13, 9);
      d.confirmationDetails.completedAt = ts(11, 15);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(9, 8);
      d.packagingDetails.completedAt = ts(5, 12);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(4, 9);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7921';
      d.documentationDetails.shippingDocRef = 'SH-2350';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(3, 8);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'NordFleet Logistics';
      d.dispatchDetails.trackingNumber = 'TRK-90506';
      d.dispatchDetails.dispatchDate = iso(-3);
      d.dispatchDetails.completedAt = ts(2, 12);
      d.deliveryDetails.startedAt = ts(2, 9);
      d.deliveryDetails.status = 'DELAYED';
      d.deliveryDetails.delayReason = 'Flood road closure - carrier re-routing (add 3 days)';
      d.deliveryDetails.expectedDelivery = iso(7);
      d.delayReason = 'Flood road closure - carrier re-routing (add 3 days)';
      d.deliveryDetails.issues.push({ note: 'Delayed: Flood road closure, re-route booked', by: 'Dean Delivery', at: ts(0, 10) });
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 17],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 13],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 11],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 11],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 9],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 5],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 5],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 4],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 3],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 2],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 2],
      ['DELIVERY', 'PENDING', 'IN_PROGRESS', 'start', 'Delivery in transit (demo)', 'start', null, 2],
      ['DELIVERY', 'IN_PROGRESS', 'DELAYED', 'delay', 'Delay recorded - Flood road closure', 'delay', 'Flood road closure - carrier re-routing (add 3 days)', 0],
    ],
  },
  {
    code: 'PKG-1015', project: 'Bluefin Chilled Goods', customer: 'Catering Hub Eesti',
    publicCustomer: true, orderRef: 'PO-89335', details: 'Chiller units x2, temperature loggers included',
    expected: iso(-9), createdDays: 20, stage: 'DELIVERED', status: 'COMPLETED', updatedAt: ts(8, 15),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-18);
      d.confirmationDetails.startedAt = ts(16, 9);
      d.confirmationDetails.completedAt = ts(14, 11);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(12, 8);
      d.packagingDetails.completedAt = ts(10, 13);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(9, 8);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7955';
      d.documentationDetails.shippingDocRef = 'SH-2377';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(9, 12);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'Ceylon Carriers OÜ';
      d.dispatchDetails.trackingNumber = 'TRK-90611';
      d.dispatchDetails.dispatchDate = iso(-9);
      d.dispatchDetails.completedAt = ts(8, 15);
      d.deliveryDetails.startedAt = ts(8, 16);
      d.deliveryDetails.status = 'COMPLETED';
      d.deliveryDetails.actualDelivery = ts(8, 18);
      d.deliveryDetails.remarks = 'Signed by site storekeeper, POD reference QX-441';
      d.actualDelivery = ts(8, 18);
      d.delayReason = null;
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 20],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 16],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 14],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 14],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 12],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 10],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 10],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 9],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 9],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 8],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 8],
      ['DELIVERY', 'PENDING', 'IN_PROGRESS', 'start', 'Delivery in transit (demo)', 'start', null, 8],
      ['DELIVERED', 'COMPLETED', 'COMPLETED', 'deliver', 'Package delivered (demo)', 'deliver', null, 8],
    ],
  },
  {
    code: 'PKG-1016', project: 'Lakeside Office Modules', customer: 'Workspaces Co',
    publicCustomer: true, orderRef: 'PO-89420', details: 'Modular wall panels, 5 flatpacks',
    expected: iso(-2), createdDays: 25, stage: 'DELIVERED', status: 'COMPLETED', updatedAt: ts(10, 17),
    extra: (d) => {
      d.confirmationDetails.confirmDate = iso(-23);
      d.confirmationDetails.startedAt = ts(21, 9);
      d.confirmationDetails.completedAt = ts(19, 10);
      d.confirmationDetails.status = 'COMPLETED';
      d.packagingDetails.startedAt = ts(16, 8);
      d.packagingDetails.completedAt = ts(13, 12);
      d.packagingDetails.status = 'COMPLETED';
      d.documentationDetails.startedAt = ts(12, 9);
      d.documentationDetails.status = 'COMPLETED';
      d.documentationDetails.invoiceNumber = 'INV-7990';
      d.documentationDetails.shippingDocRef = 'SH-2401';
      d.documentationDetails.verificationStatus = 'VERIFIED';
      d.documentationDetails.verifiedAt = ts(12, 11);
      d.dispatchDetails.status = 'COMPLETED';
      d.dispatchDetails.transporter = 'NordFleet Logistics';
      d.dispatchDetails.trackingNumber = 'TRK-90700';
      d.dispatchDetails.dispatchDate = iso(-11);
      d.dispatchDetails.completedAt = ts(10, 17);
      d.deliveryDetails.startedAt = ts(10, 9);
      d.deliveryDetails.status = 'COMPLETED';
      d.deliveryDetails.actualDelivery = ts(10, 12);
      d.deliveryDetails.remarks = 'Delivered on due date - POD attached to manifest';
      d.actualDelivery = ts(10, 12);
    },
    hist: [
      ['CONFIRMATION', 'N/A', 'PENDING', 'create', 'Package created at the Confirmation stage (demo)', null, null, 25],
      ['CONFIRMATION', 'PENDING', 'IN_PROGRESS', 'start', 'Confirmation started', 'start', null, 21],
      ['CONFIRMATION', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Confirmation completed (demo)', 'complete', null, 19],
      ['PACKAGING', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Packaging (pending)', 'advance', null, 19],
      ['PACKAGING', 'PENDING', 'IN_PROGRESS', 'start', 'Packaging started', 'start', null, 16],
      ['PACKAGING', 'IN_PROGRESS', 'COMPLETED', 'complete', 'Packaging completed (demo)', 'complete', null, 13],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Documentation/Dispatch (pending)', 'advance', null, 13],
      ['DOCUMENTATION_DISPATCH', 'PENDING', 'IN_PROGRESS', 'start-doc', 'Documentation started', 'start-doc', null, 12],
      ['DOCUMENTATION_DISPATCH', 'IN_PROGRESS', 'COMPLETED', 'verify', 'Documents verified - ready for dispatch (demo)', 'verify', null, 12],
      ['DOCUMENTATION_DISPATCH', 'COMPLETED', 'COMPLETED', 'complete', 'Dispatch/handover completed (demo)', 'complete', null, 10],
      ['DELIVERY', 'COMPLETED', 'PENDING', 'advance', 'Stage advanced to Delivery (pending)', 'advance', null, 10],
      ['DELIVERY', 'PENDING', 'IN_PROGRESS', 'start', 'Delivery in transit (demo)', 'start', null, 10],
      ['DELIVERED', 'COMPLETED', 'COMPLETED', 'deliver', 'Package delivered (demo)', 'deliver', null, 10],
    ],
  },
];

async function collectUids() {
  const map = {};
  for (const emp of DEMO_EMPLOYEES) {
    const found = await employeesService.getByEmail(emp.email);
    if (found) map[emp.role] = { uid: found.uid, name: found.name };
  }
  return map;
}

function buildDoc(sc, uidsByRole) {
  const d = baseDetails(sc.expected);
  sc.extra(d);
  const actorFor = (role) => uidsByRole[role] || { uid: 'demo-seed', name: 'Demo Seeder' };
  const roleForStage = {
    CONFIRMATION: 'CONFIRM', PACKAGING: 'PACK',
    DOCUMENTATION_DISPATCH: 'DOC', DELIVERY: 'DEL', DELIVERED: 'DEL',
  };
  const data = {
    packageCode: sc.code,
    projectName: sc.project,
    customerName: sc.customer,
    publicCustomer: sc.publicCustomer === true,
    orderReference: sc.orderRef,
    orderDetails: sc.details,
    currentStage: sc.stage,
    status: sc.status,
    confirmationDetails: d.confirmationDetails,
    packagingDetails: d.packagingDetails,
    documentationDetails: d.documentationDetails,
    dispatchDetails: d.dispatchDetails,
    deliveryDetails: d.deliveryDetails,
    expectedDelivery: sc.expected,
    actualDelivery: d.deliveryDetails.actualDelivery || null,
    delayReason: d.delayReason || null,
    createdAt: ts(sc.createdDays, 14),
    updatedAt: sc.updatedAt,
  };
  const history = (sc.hist).map(([stage, previousStatus, newStatus, action, remarks, type, reason, daysAgo]) => ({
    stage,
    previousStatus,
    newStatus,
    updatedBy: actorFor(roleForStage[stage]).name,
    updatedById: actorFor(roleForStage[stage]).uid,
    timestamp: ts(daysAgo, 12),
    remarks: remarks || '',
    action: (type === 'created' ? 'create' : type) || '',
    reason: reason || '',
  }));
  return { data, history };
}

/** Seeds demo employees + packages. force overwrites existing packages. */
async function seedDemoData({ force = false } = {}) {
  if (!fb.isReady()) {
    const e = new Error('Firebase is not configured - cannot seed demo data. '
      + fb.notReadyMessage());
    e.status = 503;
    throw e;
  }
  const db = fb.firestore();
  const summary = { employeesCreated: [], packagesCreated: [], packagesSkipped: [] };

  for (const emp of DEMO_EMPLOYEES) {
    try {
      const created = await employeesService.create({ ...emp, password: DEMO_PASSWORD });
      summary.employeesCreated.push(`${created.email} (${created.role})`);
    } catch (err) {
      if (err && (err.status === 409 || /already exists/i.test(err.message || ''))) {
        continue; // profile already there
      }
      throw err;
    }
  }

  const uids = await collectUids();
  for (const sc of SCENARIOS) {
    const ref = db.collection('packages').doc(sc.code);
    const snap = await ref.get();
    if (snap.exists && !force) {
      summary.packagesSkipped.push(sc.code);
      continue;
    }
    const { data, history } = buildDoc(sc, uids);
    await ref.set(data);
    for (const ev of history) {
      await ref.collection('history').add(ev);
    }
    summary.packagesCreated.push(sc.code);
  }
  return summary;
}

async function seedDemoCli(force) {
  fb.init();
  const ok = await fb.verify();
  if (!ok) {
    const msg = String(fb.notReadyMessage());
    const proj = process.env.FB_PROJECT_ID || 'YOUR-PROJECT-ID';
    console.error('\n[seed] Cannot seed demo data: ' + msg);
    if (/Service account file not found/i.test(msg)) {
      // credentials file missing -> the 2-minute download walkthrough
      const credPath = require('path').resolve(process.env.BLINDSPOT_FIREBASE_CREDENTIALS
        || './secrets/blindspot-service-account.json');
      console.error('\n[seed] The backend needs the ADMIN service-account JSON (the web API key');
      console.error('[seed] from Project settings > General is not enough for Firestore writes).');
      console.error('[seed] Save it as exactly:');
      console.error('[seed]   ' + credPath);
      console.error('\n[seed] 2-minute walkthrough:');
      console.error('[seed]   1. https://console.firebase.google.com  ->  open your project ('
        + proj + ')');
      console.error('[seed]   2. Gear icon  ->  Project settings');
      console.error('[seed]   3. Tab "Service accounts"');
      console.error('[seed]   4. Click "Generate new private key"  ->  Confirm');
      console.error('[seed]   5. Move the downloaded .json file to the path above');
      console.error('[seed]   6. Run again: npm run seed:demo');
    } else if (/Cloud Firestore API|firestore\.googleapis\.com/i.test(msg)) {
      // Firestore API disabled / database not created yet
      console.error('\n[seed] Your service account works! But the Cloud Firestore database');
      console.error('[seed] has not been created / its API is not enabled yet.');
      console.error('[seed] Fix (about 3 clicks):');
      console.error('[seed]   1. Open  https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=' + proj);
      console.error('[seed]      and click "Enable".');
      console.error('[seed]   2. Firebase console -> Firestore Database -> "Create database"');
      console.error('[seed]      (location + mode are fine with the defaults).');
      console.error('[seed]   3. Also: Firebase console -> Authentication -> Sign-in method');
      console.error('[seed]      -> enable Email/Password (needed for the demo employees).');
      console.error('[seed]   4. Wait ~1 minute, then run again: npm run seed:demo');
    } else {
      console.error('[seed] Troubleshooting: check that the project ('
        + proj + ') has a Firestore database,');
      console.error('[seed] that Email/Password sign-in is enabled, and that the service');
      console.error('[seed] account JSON at ' + require('path').resolve(process.env.BLINDSPOT_FIREBASE_CREDENTIALS
        || './secrets/blindspot-service-account.json') + ' is complete.');
    }
    console.error('[seed] Full details: README section 1.');
    process.exit(1);
    return;
  }
  const s = await seedDemoData({ force });
  console.log('\n=== Blindspot DEMO data ===');
  if (s.employeesCreated.length) {
    console.log('Employees created (' + s.employeesCreated.length + '):');
    s.employeesCreated.forEach((e) => console.log('  + ' + e));
  } else {
    console.log('Employees: already exist (skipped).');
  }
  if (s.packagesCreated.length) {
    console.log('Packages seeded (' + s.packagesCreated.length + '): ' + s.packagesCreated.join(', '));
  }
  if (s.packagesSkipped.length) {
    console.log('Packages skipped as existing (' + s.packagesSkipped.length + ') - use --force to overwrite: ' + s.packagesSkipped.join(', '));
  }
  console.log('\nDemo logins (password: ' + DEMO_PASSWORD + '):');
  DEMO_EMPLOYEES.forEach((e) => console.log('  ' + e.role.padEnd(8) + ' ' + e.email));
  console.log('\nOpen http://localhost:8080  and  http://localhost:8080/login');
}

module.exports = { seedDemoData, seedDemoCli, DEMO_PASSWORD, DEMO_EMPLOYEES };
