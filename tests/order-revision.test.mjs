import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { saveCustomer, saveOrderDraft, createInvoiceFromOrder, updateInvoiceCustomerName, cancelOrder } from '../functions/order-operations.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore emulator.');
const app = initializeApp({ projectId: 'demo-suh-oms' }, 'order-revision-test');
const db = getFirestore(app);

test.before(async () => {
  for (const name of ['users', 'items', 'units', 'inventory', 'customers', 'customerContacts', 'orders', 'orderCounters', 'invoices', 'payments', 'auditLogs', 'inventoryMovements']) {
    const docs = await db.collection(name).get();
    if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true, displayName: 'Admin' }),
    db.doc('users/accountA').set({ role: 'account_admin', active: true, displayName: 'Accounts' }),
    db.doc('users/userA').set({ role: 'user', active: true, displayName: 'User' }),
    db.doc('units/kg').set({ name: 'Kilogram', symbol: 'kg', active: true }),
    db.doc('items/itemA').set({ itemCode: 'A', name: 'Sweet A', defaultUnitId: 'kg', defaultSellingPrice: 100, active: true }),
    db.doc('inventory/itemA').set({ onHandQty: 10000, reservedQty: 0, sellingBlocked: false, lowStockThresholdQty: 0 }),
  ]);
});
test.after(async () => deleteApp(app));

test('invoiced revision adjusts only the difference, preserves invoice number, and cancellation restores once', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', { fullName: 'Asha', contact: '9876543210', address: 'Main Street', area: 'West' });
  const input = (quantityQty) => ({ customerId, assignedUserId: 'userA', orderDate: '2026-10-10', deliveryDate: null, notes: '', lines: [{ kind: 'item', productId: 'itemA', quantityQty }] });
  const { orderId } = await saveOrderDraft(db, 'adminA', input(2000));
  await createInvoiceFromOrder(db, 'adminA', orderId);
  const original = (await db.doc(`invoices/${orderId}`).get()).data();
  await assert.rejects(saveOrderDraft(db, 'userA', { ...input(3000), orderId }), /invoice exists/);
  await assert.rejects(saveOrderDraft(db, 'accountA', { ...input(3000), orderId }), /invoice exists/);
  await saveOrderDraft(db, 'adminA', { ...input(3000), orderId });
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 7000);
  let invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(invoice.invoiceNumber, original.invoiceNumber);
  assert.equal(invoice.totalPaise, 30000);
  await updateInvoiceCustomerName(db, 'adminA', { invoiceId: orderId, fullName: 'Asha New' });
  await assert.rejects(updateInvoiceCustomerName(db, 'accountA', { invoiceId: orderId, fullName: 'Wrong' }), /Only Admin/);
  invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(invoice.customerSnapshot.fullName, 'Asha New');
  assert.equal((await db.doc(`customers/${customerId}`).get()).data().fullName, 'Asha');
  await db.doc(`invoices/${orderId}`).update({ verifiedPaidPaise: 20000, paymentStatus: 'partial' });
  await saveOrderDraft(db, 'adminA', { ...input(1000), orderId });
  invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(invoice.paymentStatus, 'overpaid');
  assert.equal(invoice.balancePaise, -10000);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 9000);
  await db.doc('payments/paymentA').set({ orderId, invoiceId: orderId, verificationStatus: 'verified', amountPaise: 20000, ownerUid: 'userA' });
  await assert.rejects(cancelOrder(db, 'accountA', orderId, 'Customer request'), /Only Admin/);
  await cancelOrder(db, 'adminA', orderId, 'Customer request');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 10000);
  await assert.rejects(cancelOrder(db, 'adminA', orderId, 'Again'), /cannot be cancelled/);
  invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(invoice.status, 'cancelled');
  assert.equal(invoice.verifiedPaidPaise, 20000);
  assert.equal(invoice.invoiceNumber, original.invoiceNumber);
  assert.equal((await db.doc('payments/paymentA').get()).data().amountPaise, 20000);
  const second = await saveOrderDraft(db, 'adminA', input(1000));
  const secondOrder = (await db.doc(`orders/${second.orderId}`).get()).data();
  await db.doc(`orders/${second.orderId}`).update({
    stockDeductions: [{ ...secondOrder.stockDeductions[0], quantityQty: 500 }],
    stockReservations: [{ ...secondOrder.stockDeductions[0], quantityQty: 500 }],
  });
  await db.doc('inventory/itemA').update({ onHandQty: 9500, reservedQty: 500 });
  await cancelOrder(db, 'adminA', second.orderId, 'Partial stock use');
  const stock = (await db.doc('inventory/itemA').get()).data();
  assert.equal(stock.onHandQty, 10000);
  assert.equal(stock.reservedQty, 0);
});
