import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { submitPayment, reviewPayment, reversePayment, markInvoicePaid } from '../functions/finance-operations.js';
import { invoicePdfModel } from '../js/invoice-pdf.js';
import { createInvoiceFromOrder } from '../functions/order-operations.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore emulator.');
const app = initializeApp({ projectId: 'demo-suh-oms' }, 'finance-test');
const db = getFirestore(app);
const invoice = () => db.doc('invoices/orderA').get().then((snap) => snap.data());

test.beforeEach(async () => {
  for (const name of ['users', 'orders', 'invoices', 'payments', 'paymentReferences', 'paymentReversals', 'auditLogs']) {
    const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true }), db.doc('users/accountA').set({ role: 'account_admin', active: true }),
    db.doc('users/userA').set({ role: 'user', active: true }), db.doc('users/userB').set({ role: 'user', active: true }),
    db.doc('orders/orderA').set({ status: 'confirmed', ownerUid: 'userA', orderNumber: 'SS-2026-000001', customerId: 'customerA', customerSnapshot: { fullName: 'Asha', contact: '123', address: 'Road', area: 'West', sabha: true }, lines: [{ kind: 'item', itemSnapshot: { name: 'Sweet', unitSymbol: 'kg' }, quantityQty: 1000, unitPricePaise: 10000, lineTotalPaise: 10000 }], subtotal: 10000, grandTotal: 10000 }),
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
  const b = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 6000, mode: 'upi', transactionNumber: 'upi-123' });
  assert.equal((await invoice()).verifiedPaidPaise, 0);
  assert.equal((await db.doc(`payments/${a.paymentId}`).get()).data().transactionNumber, '-');
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  assert.equal((await invoice()).paymentStatus, 'partial');
  await reviewPayment(db, 'accountA', { paymentId: b.paymentId, decision: 'verified' });
  assert.equal((await invoice()).paymentStatus, 'ready_to_mark_paid');
  assert.equal((await invoice()).verifiedPaidPaise, 10000);
  await markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' });
  assert.equal((await invoice()).paymentStatus, 'paid');
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /already marked/);
});

test('online references are unique after normalization and cannot be reused', async () => {
  await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'upi', transactionNumber: 'AbC-123' });
  await assert.rejects(submitPayment(db, 'adminA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'bank_transfer', transactionNumber: 'abc-123' }), /already been submitted/);
  await assert.rejects(submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'upi', transactionNumber: '' }), /reference/);
});

test('insufficient and stale balances block Mark as Paid', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 3000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /do not reconcile/);
  await db.doc('invoices/orderA').update({ verifiedPaidPaise: 10000 });
  await assert.rejects(markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' }), /do not reconcile/);
});

test('only Account Admin marks paid; ownership and review permissions hold', async () => {
  await assert.rejects(submitPayment(db, 'userB', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' }), /own invoices/);
  await assert.rejects(markInvoicePaid(db, 'adminA', { invoiceId: 'orderA' }), /Account Admin access/);
  await assert.rejects(markInvoicePaid(db, 'userA', { invoiceId: 'orderA' }), /Account Admin access/);
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 1000, mode: 'cash' });
  await assert.rejects(reviewPayment(db, 'userA', { paymentId: a.paymentId, decision: 'verified' }), /access is required/);
});

test('competing verification cannot over-credit invoice', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 7000, mode: 'cash' });
  const b = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 7000, mode: 'cash' });
  const results = await Promise.allSettled([reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' }), reviewPayment(db, 'accountA', { paymentId: b.paymentId, decision: 'verified' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await invoice()).verifiedPaidPaise, 7000);
});

test('explicit reversal preserves payment history and updates balance once', async () => {
  const a = await submitPayment(db, 'userA', { invoiceId: 'orderA', amountPaise: 10000, mode: 'cash' });
  await reviewPayment(db, 'adminA', { paymentId: a.paymentId, decision: 'verified' });
  await markInvoicePaid(db, 'accountA', { invoiceId: 'orderA' });
  await reversePayment(db, 'adminA', { paymentId: a.paymentId, reason: 'Bank discrepancy' });
  assert.equal((await invoice()).paymentStatus, 'unpaid');
  assert.equal((await invoice()).verifiedPaidPaise, 0);
  assert.equal((await db.doc(`paymentReversals/${a.paymentId}`).get()).data().reason, 'Bank discrepancy');
  await assert.rejects(reversePayment(db, 'adminA', { paymentId: a.paymentId, reason: 'Again' }), /unreversed/);
});
