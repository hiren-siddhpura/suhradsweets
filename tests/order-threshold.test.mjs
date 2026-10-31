import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { saveCustomer, saveOrderDraft, cancelOrder } from '../functions/order-operations.js';
import { getOrderStock } from '../functions/order-reads.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore emulator.');
const app = initializeApp({ projectId: 'demo-suh-oms' }, 'order-threshold-test');
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
    db.doc('inventory/itemA').set({ onHandQty: 4000, reservedQty: 0, lowStockThresholdQty: 2000, sellingBlocked: false }),
  ]);
});
test.after(async () => deleteApp(app));

test('threshold and block state restrict Users and Account Admin, while Admin can order within available stock', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', { fullName: 'Asha', contact: '9876543210', address: '', area: 'West', assignedUserId: 'userA' });
  const input = (quantityQty, assignedUserId) => ({ customerId, ...(assignedUserId ? { assignedUserId } : {}), orderDate: '2026-10-10', deliveryDate: null, notes: '', lines: [{ kind: 'item', productId: 'itemA', quantityQty }] });
  const status = async () => (await getOrderStock(db, 'userA', { itemIds: ['itemA'] })).items[0].status;
  assert.equal(await status(), 'available');
  const first = await saveOrderDraft(db, 'userA', input(1000));
  assert.equal(await status(), 'available');
  await db.doc('inventory/itemA').update({ onHandQty: 2000 });
  assert.equal(await status(), 'low_stock');
  await assert.rejects(saveOrderDraft(db, 'userA', input(1000)), /stock threshold/);
  await db.doc('orders/legacyDraft').set({ orderNumber: 'SS-DRAFT', customerId, customerSnapshot: { fullName: 'Asha', contact: '9876543210', address: '', area: 'West' }, ownerUid: 'userA', assignedUserId: 'userA', status: 'draft', orderDate: '2026-10-10', lines: input(1000).lines, subtotal: 10000, grandTotal: 10000, notes: '', stockDeductions: [] });
  await assert.rejects(saveOrderDraft(db, 'userA', { ...input(1000), orderId: 'legacyDraft' }), /stock threshold/);
  await assert.rejects(saveOrderDraft(db, 'accountA', input(1000, 'accountA')), /stock threshold/);
  await db.doc('inventory/itemA').update({ onHandQty: 1500 });
  assert.equal(await status(), 'low_stock');
  await assert.rejects(saveOrderDraft(db, 'userA', input(1000)), /stock threshold/);
  const adminOrder = await saveOrderDraft(db, 'adminA', input(1000, 'adminA'));
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 500);
  await cancelOrder(db, 'adminA', adminOrder.orderId, 'Test restoration');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 1500);
  await db.doc('inventory/itemA').update({ onHandQty: 4000, sellingBlocked: true });
  assert.equal(await status(), 'blocked');
  await assert.rejects(saveOrderDraft(db, 'userA', input(1000)), /blocked/);
  await assert.rejects(saveOrderDraft(db, 'adminA', input(5000, 'adminA')), /Insufficient available stock/);
  const blockedAdminOrder = await saveOrderDraft(db, 'adminA', input(1000, 'adminA'));
  assert.ok(blockedAdminOrder.orderId);
  await cancelOrder(db, 'adminA', blockedAdminOrder.orderId, 'Test restoration');
  await db.doc('inventory/itemA').update({ sellingBlocked: false });
  assert.equal(await status(), 'available');
  await db.doc('inventory/itemA').update({ onHandQty: 2000 });
  assert.equal(await status(), 'low_stock');
  await db.doc('items/itemA').update({ active: false });
  await assert.rejects(saveOrderDraft(db, 'adminA', input(1000, 'adminA')), /missing or inactive/);
  assert.ok(first.orderId);
});
