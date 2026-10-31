import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { submitPayment, reviewPayment, changePaymentMode, reversePayment, markInvoicePaid } from '../functions/finance-operations.js';
import { invoicePdfModel } from '../js/invoice-pdf.js';
import { createInvoiceFromOrder } from '../functions/order-operations.js';
import { getPaymentNames, listOrderActivity, listPaymentActivity } from '../functions/order-reads.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore and Storage emulators.');
const app = initializeApp({ projectId: 'demo-suh-oms', storageBucket: 'demo-suh-oms.firebasestorage.app' });
const db = getFirestore(app);
const invoice = () => db.doc('invoices/orderA').get().then((snap) => snap.data());
async function proof(uid, operationId) {
  await getStorage().bucket().file(`paymentReceipts/${uid}/${operationId}.pdf`).save(Buffer.from('%PDF-1.4\n%%EOF'), { metadata: { contentType: 'application/pdf', metadata: { ownerUid: uid, invoiceId: 'orderA', originalName: 'proof.pdf' } } });
  return { operationId, attachment: { extension: 'pdf' } };
}

test.beforeEach(async () => {
  for (const name of ['users', 'orders', 'invoices', 'payments', 'paymentReferences', 'paymentReversals', 'auditLogs']) {
    const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true }), db.doc('users/opsAdmin').set({ role: 'user', active: true }), db.doc('users/accountA').set({ role: 'account_admin', active: true }),
    db.doc('users/userA').set({ role: 'user', active: true }), db.doc('users/userB').set({ role: 'user', active: true }),
    db.doc('orders/orderA').set({ status: 'confirmed', ownerUid: 'userA', orderNumber: 'SS-2026-000001', customerId: 'customerA', customerSnapshot: { fullName: 'Asha', contact: '123', address: 'Road', area: 'West', sabha: true }, lines: [{ kind: 'item', itemSnapshot: { name: 'Sweet', unitSymbol: 'kg' }, quantityQty: 1000, unitPricePaise: 10000, lineTotalPaise: 10000 }], stockDeductions: [{ itemId: 'sweet', quantityQty: 1000 }], subtotal: 10000, grandTotal: 10000 }),
  ]);
  await createInvoiceFromOrder(db, 'adminA', 'orderA');
});
test.after(async () => deleteApp(app));

test('manual invoice is unique and customer-facing PDF model excludes Sabha', async () => {
  await assert.rejects(createInvoiceFromOrder(db, 'accountA', 'orderA'), /already exists/);
  const data = await invoice();
  assert.equal(data.customerSnapshot.sabha, undefined);
  assert.equal(JSON.stringify(invoicePdfModel({ ...data, customerSnapshot: { ...data.customerSnapshot, sabha: true } })).includes('sabha'), false);
  assert.equal(data.invoiceNumber, 'INV-SS-2026-000001');
});

test('partial and multiple payments count only after verification', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 4000, mode: 'cash' });
  assert.equal((await invoice()).paymentStatus, 'in_process');
  assert.equal((await invoice()).verifiedPaidPaise, 0);
  await assert.rejects(submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 6000, mode: 'upi', transactionNumber: 'upi-123', ...await proof('userA', 'pending-upi') }), /already in process/);
  assert.equal((await db.doc(`payments/${a.paymentId}`).get()).data().transactionNumber, '-');
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  assert.equal((await invoice()).paymentStatus, 'partial');
  const b = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 6000, mode: 'upi', transactionNumber: 'upi-123', ...await proof('userA', 'verified-upi') });
  assert.equal((await invoice()).paymentStatus, 'in_process');
  assert.equal((await invoice()).verifiedPaidPaise, 4000);
  await reviewPayment(db, 'accountA', { paymentId: b.paymentId, decision: 'verified' });
  assert.equal((await invoice()).paymentStatus, 'paid');
  assert.equal((await invoice()).verifiedPaidPaise, 10000);
  assert.equal((await invoice()).paidBy, 'accountA');
  assert.ok((await invoice()).paidAt);
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /already marked/);
});

test('online references are unique after normalization and cannot be reused', async () => {
  await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'upi', transactionNumber: 'AbC-123', ...await proof('userA', 'reference-first') });
  await assert.rejects(submitPayment(db, 'adminA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'bank_transfer', transactionNumber: 'abc-123', ...await proof('adminA', 'reference-second') }), /already been submitted/);
  await assert.rejects(submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'upi', transactionNumber: '' }), /reference/);
});

test('review refuses a malformed legacy online payment even when staff requests verification', async () => {
  const result = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'upi', transactionNumber: 'valid-123', ...await proof('userA', 'legacy-malformed') });
  await db.doc(`payments/${result.paymentId}`).update({ transactionNumber: '' });
  await assert.rejects(reviewPayment(db, 'adminA', { paymentId: result.paymentId, decision: 'verified' }), /reference/);
  assert.equal((await invoice()).verifiedPaidPaise, 0);
});

test('insufficient and stale balances block Mark as Paid', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 3000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /do not reconcile/);
  await db.doc('invoices/orderA').update({ verifiedPaidPaise: 10000 });
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /do not reconcile/);
});

test('only privileged roles mark paid; ownership and review permissions hold', async () => {
  await assert.rejects(submitPayment(db, 'userB', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' }), /own invoices/);
  await assert.rejects(markInvoicePaid(db, 'opsAdmin', { invoiceId: 'orderA' }), /access is required/i);
  await assert.rejects(markInvoicePaid(db, 'userA', { invoiceId: 'orderA' }), /access is required/i);
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' });
  await assert.rejects(reviewPayment(db, 'userA', { paymentId: a.paymentId, decision: 'verified' }), /access is required/i);
  await assert.rejects(reviewPayment(db, 'opsAdmin', { paymentId: a.paymentId, decision: 'verified' }), /access is required/i);
  await assert.rejects(reversePayment(db, 'opsAdmin', { paymentId: a.paymentId, reason: 'No authority' }), /access is required/i);
});

test('competing submissions allow one pending payment and cannot over-credit invoice', async () => {
  const results = await Promise.allSettled([
    submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 7000, mode: 'cash', operationId: 'competing-a' }),
    submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 7000, mode: 'cash', operationId: 'competing-b' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await invoice()).paymentStatus, 'in_process');
  const paymentId = results.find((result) => result.status === 'fulfilled').value.paymentId;
  await reviewPayment(db, 'adminA', { paymentId, decision: 'verified' });
  assert.equal((await invoice()).verifiedPaidPaise, 7000);
  assert.equal((await invoice()).paymentStatus, 'partial');
});

test('rejecting a pending payment restores the invoice status without recording funds', async () => {
  const pending = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 4000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: pending.paymentId, decision: 'rejected', reason: 'Incorrect amount' });
  assert.equal((await invoice()).paymentStatus, 'unpaid');
  assert.equal((await invoice()).verifiedPaidPaise, 0);
  const replacement = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 4000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: replacement.paymentId, decision: 'verified' });
  const next = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 6000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: next.paymentId, decision: 'rejected', reason: 'Not received' });
  assert.equal((await invoice()).paymentStatus, 'partial');
  assert.equal((await invoice()).verifiedPaidPaise, 4000);
});

test('an older pending payment blocks another submission even if the invoice still says unpaid', async () => {
  await db.doc('payments/legacyPending').set({ invoiceId: 'orderA', orderId: 'orderA', ownerUid: 'userA', verificationStatus: 'unverified', amountPaise: 1000, mode: 'cash', transactionNumber: '-' });
  await assert.rejects(submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' }), /already in process/);
  assert.equal((await invoice()).paymentStatus, 'unpaid');
  assert.equal((await db.collection('payments').get()).size, 1);
});

test('explicit reversal preserves payment history and updates balance once', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 10000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  assert.equal((await invoice()).paymentStatus, 'paid');
  await reversePayment(db, 'adminA', { paymentId: a.paymentId, reason: 'Bank discrepancy' });
  assert.equal((await invoice()).paymentStatus, 'unpaid');
  assert.equal((await invoice()).verifiedPaidPaise, 0);
  assert.equal((await db.doc(`paymentReversals/${a.paymentId}`).get()).data().reason, 'Bank discrepancy');
  await assert.rejects(reversePayment(db, 'adminA', { paymentId: a.paymentId, reason: 'Again' }), /unreversed/);
});

test('payment names come from trusted profiles and snapshots; users see only owned payments', async () => {
  await db.doc('users/userA').update({ fullName: 'Submitting User' });
  await db.doc('users/adminA').update({ fullName: 'Verifying Admin' });
  const result = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: result.paymentId, decision: 'verified' });
  const saved = (await db.doc(`payments/${result.paymentId}`).get()).data();
  assert.equal(saved.submittedBy, 'userA');
  assert.equal(saved.submittedByName, 'Submitting User');
  assert.equal(saved.verifiedBy, 'adminA');
  assert.equal(saved.verifiedByName, 'Verifying Admin');
  const names = await getPaymentNames(db, 'userA', { paymentIds: [result.paymentId] });
  assert.equal(names.payments[0].customerName, 'Asha');
  assert.equal(names.payments[0].submittedByName, 'Submitting User');
  assert.equal(names.payments[0].verifiedByName, 'Verifying Admin');
  await assert.rejects(getPaymentNames(db, 'userB', { paymentIds: [result.paymentId] }), /access is denied/);
  const activity = await listOrderActivity(db, 'userA', { filters: { type: 'order.payment_submitted' } });
  assert.equal(activity.rows.length, 1);
  assert.equal(activity.rows[0].actorName, 'Submitting User');
  assert.equal((await listOrderActivity(db, 'userA', { filters: { payment: result.paymentId } })).rows.length, 1);
  assert.equal((await listOrderActivity(db, 'userA', { filters: { invoice: 'INV-SS-2026-000001' } })).rows.length, 1);
  await db.doc(`payments/${result.paymentId}`).update({ submittedByName: null, verifiedByName: null, customerSnapshot: null });
  const older = await getPaymentNames(db, 'userA', { paymentIds: [result.paymentId] });
  assert.equal(older.payments[0].submittedByName, 'Submitting User');
  assert.equal(older.payments[0].customerName, 'Asha');
  await db.doc('users/adminA').delete();
  assert.equal((await getPaymentNames(db, 'userA', { paymentIds: [result.paymentId] })).payments[0].verifiedByName, 'Unknown user');
});

test('stable request ID makes cash retries idempotent without duplicate payment or audit', async () => {
  const input = { invoiceId: 'orderA', amountPaise: 1200, mode: 'cash', operationId: 'cash-request-1', remarks: 'Received at counter' };
  const first = await submitPayment(db, 'userA', input);
  const retry = await submitPayment(db, 'userA', input);
  assert.equal(retry.paymentId, first.paymentId);
  assert.equal(retry.alreadySubmitted, true);
  assert.equal((await db.collection('payments').get()).size, 1);
  assert.equal((await db.doc(`payments/${first.paymentId}`).get()).data().remarks, 'Received at counter');
  assert.equal((await listPaymentActivity(db, 'userA', { filters: { type: 'payment.submitted' } })).rows.length, 1);
  await assert.rejects(submitPayment(db, 'userA', { ...input, amountPaise: 1300 }), /already used for different details/);
  await assert.rejects(submitPayment(db, 'userA', { ...input, remarks: 'Different note' }), /already used for different details/);
});

test('staff corrects only unverified payment mode with reason and immutable audit snapshot', async () => {
  const result = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 2000, mode: 'cash', ...await proof('userA', 'mode-request') });
  await assert.rejects(changePaymentMode(db, 'userA', { paymentId: result.paymentId, mode: 'upi', transactionNumber: 'upi-789', reason: 'Customer correction' }), /access is required/i);
  await assert.rejects(changePaymentMode(db, 'opsAdmin', { paymentId: result.paymentId, mode: 'upi', transactionNumber: 'upi-789', reason: 'Customer correction' }), /access is required/i);
  await assert.rejects(changePaymentMode(db, 'adminA', { paymentId: result.paymentId, mode: 'upi', transactionNumber: '', reason: 'Correction' }), /reference/);
  await changePaymentMode(db, 'adminA', { paymentId: result.paymentId, mode: 'upi', transactionNumber: 'upi-789', reason: 'Customer correction' });
  const changed = (await db.doc(`payments/${result.paymentId}`).get()).data();
  assert.equal(changed.mode, 'upi'); assert.equal(changed.transactionNumber, 'UPI-789');
  const activity = await listPaymentActivity(db, 'userA', { filters: { type: 'payment.mode_changed', payment: result.paymentId } });
  assert.equal(activity.rows.length, 1);
  assert.deepEqual(activity.rows[0].changedFields.mode, { before: 'cash', after: 'upi' });
  assert.equal(activity.rows[0].reason, 'Customer correction');
  await changePaymentMode(db, 'adminA', { paymentId: result.paymentId, mode: 'cash', reason: 'Cash instead' });
  await changePaymentMode(db, 'adminA', { paymentId: result.paymentId, mode: 'upi', transactionNumber: 'upi-789', reason: 'Original reference confirmed' });
  await reviewPayment(db, 'adminA', { paymentId: result.paymentId, decision: 'verified' });
  await assert.rejects(changePaymentMode(db, 'adminA', { paymentId: result.paymentId, mode: 'cash', reason: 'Too late' }), /Only an unverified payment/);
});

test('payment activity is restricted to owner and shows review, rejection and snapshots', async () => {
  const result = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' });
  await reviewPayment(db, 'accountA', { paymentId: result.paymentId, decision: 'rejected', reason: 'Reference mismatch' });
  const owned = await listPaymentActivity(db, 'userA', { filters: { invoice: 'INV-SS', customer: 'Asha' } });
  assert.equal(owned.rows.length, 2);
  assert.equal(owned.rows[0].type, 'payment.rejected');
  assert.equal(owned.rows[0].customerName, 'Asha');
  assert.equal(owned.rows[0].reason, 'Reference mismatch');
  assert.equal((await listPaymentActivity(db, 'userB')).rows.length, 0);
  await assert.rejects(listPaymentActivity(db, 'userB', { cursor: owned.rows[0].id }), /cursor is unavailable/);
});
