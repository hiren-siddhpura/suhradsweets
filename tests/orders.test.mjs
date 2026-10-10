import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { saveCustomer, saveSpecialProduct, saveOrderDraft, confirmOrder, cancelOrder, advanceOrder, setOrderTaking, createInvoiceFromOrder } from '../functions/order-operations.js';
import { setInventoryControl } from '../functions/operations.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore emulator.');
const projectId = process.env.OMS_OPERATIONS_TEST_PROJECT || 'demo-suh-oms';
if (!projectId.startsWith('demo-')) throw new Error('Only emulator demo projects are allowed.');
const app = initializeApp({ projectId }, 'orders-test');
const db = getFirestore(app);
const customer = { fullName: 'Asha Shah', contact: '9876543210', address: 'Main Street', area: 'West', dateOfBirth: '1990-04-01', sabha: true };
const regularOrder = (customerId, extra = {}) => ({ customerId, assignedUserId: 'userA', orderDate: '2026-10-10', deliveryDate: null, notes: '', lines: [{ kind: 'item', productId: 'itemA', quantityQty: 2000 }], ...extra });

test.beforeEach(async () => {
  for (const name of ['users', 'items', 'units', 'inventory', 'customers', 'customerContacts', 'orders', 'orderCounters', 'orderControls', 'specialProducts', 'inventoryMovements', 'auditLogs', 'invoices']) {
    const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true, displayName: 'Admin' }),
    db.doc('users/accountA').set({ role: 'account_admin', active: true, displayName: 'Accounts' }),
    db.doc('users/userA').set({ role: 'user', active: true, displayName: 'User A' }),
    db.doc('users/userB').set({ role: 'user', active: true, displayName: 'User B' }),
    db.doc('units/kg').set({ name: 'Kilogram', symbol: 'kg', active: true }),
    db.doc('items/itemA').set({ itemCode: 'A001', name: 'Sweet A', defaultUnitId: 'kg', defaultSellingPrice: 100, active: true }),
    db.doc('items/itemB').set({ itemCode: 'B001', name: 'Sweet B', defaultUnitId: 'kg', defaultSellingPrice: 200, active: true }),
    db.doc('inventory/itemA').set({ onHandQty: 5000, reservedQty: 0, sellingBlocked: false, lowStockThresholdQty: 1000 }),
    db.doc('inventory/itemB').set({ onHandQty: 3000, reservedQty: 0, sellingBlocked: false, lowStockThresholdQty: 1000 }),
  ]);
});
test.after(async () => { await deleteApp(app); });

test('customer contact is reserved; user cannot edit customers or ownership', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  await assert.rejects(saveCustomer(db, 'adminA', { ...customer, fullName: 'Another' }), /already exists/);
  await assert.rejects(saveCustomer(db, 'userA', { ...customer, customerId, ownerUserIds: ['userA'] }), /access is required/);
  assert.deepEqual((await db.doc(`customers/${customerId}`).get()).data().ownerUserIds, []);
});

test('customer creation accepts omitted birth date and records the actor audit', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, dateOfBirth: null, sabha: false });
  const saved = (await db.doc(`customers/${customerId}`).get()).data();
  assert.equal(saved.dateOfBirth, null);
  assert.equal(saved.sabha, false);
  assert.equal(saved.createdBy, 'adminA');
  assert.deepEqual(saved.ownerUserIds, []);
  const events = await db.collection('auditLogs').where('referenceId', '==', customerId).get();
  assert.equal(events.size, 1);
  assert.equal(events.docs[0].data().type, 'customer.created');
});

test('draft leaves stock untouched; confirmation debits once with movement and link', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId, orderNumber } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  assert.match(orderNumber, /^SS-2026-\d{6}$/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
  const linked = (await db.doc(`customers/${customerId}`).get()).data();
  assert.deepEqual(linked.ownerUserIds, ['userA']); assert.equal(linked.orderLinks.userA, orderId);
  await confirmOrder(db, 'userA', orderId);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  const move = (await db.doc(`inventoryMovements/order_${orderId}_itemA`).get()).data();
  assert.equal(move.changeQty, -2000); assert.equal(move.ownerUid, 'userA');
  await assert.rejects(confirmOrder(db, 'userA', orderId), /Only a draft/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
});

test('special recipe deducts all underlying components and preserves snapshot', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { specialId } = await saveSpecialProduct(db, 'accountA', { name: 'Festive box', description: '', finalPricePaise: 50000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 250 }] });
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 1000 }, { kind: 'special', productId: specialId, quantityQty: 2000 }] }));
  await confirmOrder(db, 'adminA', orderId);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  assert.equal((await db.doc('inventory/itemB').get()).data().onHandQty, 2500);
  const before = (await db.doc(`orders/${orderId}`).get()).data().lines[1].specialSnapshot;
  await saveSpecialProduct(db, 'adminA', { specialId, name: 'Festive box v2', description: '', finalPricePaise: 60000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 750 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] });
  assert.deepEqual((await db.doc(`orders/${orderId}`).get()).data().lines[1].specialSnapshot, before);
});

test('global pause, item block and stale price prevent confirmation', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await setOrderTaking(db, 'accountA', false, 'Holiday closure');
  await assert.rejects(confirmOrder(db, 'adminA', orderId), /paused/);
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId)), /paused/);
  await setOrderTaking(db, 'adminA', true, 'Reopened');
  await setInventoryControl(db, 'adminA', { itemId: 'itemA', sellingBlocked: true, lowStockThresholdQty: 1000, reason: 'Quality check' });
  await assert.rejects(confirmOrder(db, 'adminA', orderId), /blocked/);
  await setInventoryControl(db, 'adminA', { itemId: 'itemA', sellingBlocked: false, lowStockThresholdQty: 1000, reason: 'Released' });
  await db.doc('items/itemA').update({ defaultSellingPrice: 120 });
  await assert.rejects(confirmOrder(db, 'adminA', orderId), /price or recipe changed/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
});

test('edited special recipe makes an existing draft stale', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const recipe = { name: 'Combo', description: '', finalPricePaise: 30000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] };
  const { specialId } = await saveSpecialProduct(db, 'adminA', recipe);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'special', productId: specialId, quantityQty: 1000 }] }));
  await saveSpecialProduct(db, 'adminA', { ...recipe, specialId, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 750 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] });
  await assert.rejects(confirmOrder(db, 'adminA', orderId), /price or recipe changed/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
});

test('two competing orders cannot oversell', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const first = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 4000 }] }));
  const second = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 4000 }] }));
  const results = await Promise.allSettled([confirmOrder(db, 'adminA', first.orderId), confirmOrder(db, 'accountA', second.orderId)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 1000);
  assert.equal((await db.collection('inventoryMovements').get()).size, 1);
});

test('cancellation restores once; delivered and invoiced orders cannot use ordinary cancellation', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const first = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await confirmOrder(db, 'adminA', first.orderId);
  const cancellations = await Promise.allSettled([cancelOrder(db, 'accountA', first.orderId, 'Customer changed mind'), cancelOrder(db, 'adminA', first.orderId, 'Customer changed mind')]);
  assert.equal(cancellations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
  await assert.rejects(cancelOrder(db, 'accountA', first.orderId, 'Again'), /cannot be cancelled/);
  const second = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await confirmOrder(db, 'adminA', second.orderId);
  await assert.rejects(createInvoiceFromOrder(db, 'userA', second.orderId), /access is required/);
  await createInvoiceFromOrder(db, 'accountA', second.orderId);
  const invoice = (await db.doc(`invoices/${second.orderId}`).get()).data();
  assert.equal(invoice.customerSnapshot.sabha, undefined);
  assert.equal(invoice.customerSnapshot.dateOfBirth, undefined);
  await assert.rejects(cancelOrder(db, 'adminA', second.orderId, 'Return'), /credit or return/);
  await assert.rejects(createInvoiceFromOrder(db, 'adminA', second.orderId), /already exists/);
  await advanceOrder(db, 'adminA', second.orderId, 'in_preparation');
  await advanceOrder(db, 'adminA', second.orderId, 'ready');
  await advanceOrder(db, 'adminA', second.orderId, 'delivered');
  await assert.rejects(cancelOrder(db, 'adminA', second.orderId, 'Late'), /cannot be cancelled/);
});

test('User can create own customer within draft but not another User order', async () => {
  const { orderId, customerId } = await saveOrderDraft(db, 'userA', { ...regularOrder(null), customerId: undefined, newCustomer: customer });
  assert.equal((await db.doc(`customers/${customerId}`).get()).data().orderLinks.userA, orderId);
  await assert.rejects(saveOrderDraft(db, 'userB', regularOrder(customerId, { assignedUserId: 'userB' })), /linked to your orders/);
  await assert.rejects(cancelOrder(db, 'userB', orderId, 'No'), /Only staff/);
  await cancelOrder(db, 'userA', orderId, 'Draft no longer needed');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
});
