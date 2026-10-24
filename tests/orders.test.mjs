import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { saveCustomer, saveSpecialProduct, saveOrderDraft, confirmOrder, cancelOrder, advanceOrder, setOrderTaking, createInvoiceFromOrder, archiveOrder, restoreOrder, requestOrderPayment } from '../functions/order-operations.js';
import { getOrderStock, listOrderActivity } from '../functions/order-reads.js';
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
async function makeLegacyDraft(orderId) {
  const ref = db.doc(`orders/${orderId}`), order = (await ref.get()).data();
  for (const part of order.stockDeductions) {
    const stockRef = db.doc(`inventory/${part.itemId}`);
    const stock = (await stockRef.get()).data();
    await stockRef.update({ onHandQty: stock.onHandQty + part.quantityQty });
    await db.doc(`inventoryMovements/order_${orderId}_${part.itemId}`).delete();
  }
  await ref.update({ status: 'draft', stockDeductions: [], confirmedAt: null, confirmedBy: null });
}

test.beforeEach(async () => {
  for (const name of ['users', 'items', 'units', 'inventory', 'customers', 'customerContacts', 'orders', 'orderCounters', 'orderControls', 'specialProducts', 'inventoryMovements', 'auditLogs', 'invoices', 'payments']) {
    const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true, displayName: 'Admin' }),
    db.doc('users/opsAdmin').set({ role: 'admin', active: true, displayName: 'Operations Admin' }),
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

test('operational Admin creates and edits regular orders but cannot change privileged settings', async () => {
  const { customerId } = await saveCustomer(db, 'opsAdmin', customer);
  const { orderId } = await saveOrderDraft(db, 'opsAdmin', regularOrder(customerId));
  await saveOrderDraft(db, 'opsAdmin', regularOrder(customerId, { orderId, notes: 'Updated by Admin' }));
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().notes, 'Updated by Admin');
  await assert.rejects(setOrderTaking(db, 'opsAdmin', false, 'No authority'), /Access denied/);
  await assert.rejects(saveSpecialProduct(db, 'opsAdmin', { name: 'No authority', description: '', finalPricePaise: 1000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] }), /Access denied/);
});

test('fixed unit prices are selected on the server and 250 GM is Admin only', async () => {
  await db.doc('items/itemA').update({ sellingPrice500Gm: 60, sellingPrice250Gm: 35 });
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, assignedUserId: 'userA' });
  const line = (unitId) => [{ kind: 'item', productId: 'itemA', quantityQty: 1000, unitId }];
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { assignedUserId: undefined, lines: line('250gm') })), /Only Admin may select 250 GM/);
  await assert.rejects(saveOrderDraft(db, 'accountA', regularOrder(customerId, { assignedUserId: undefined, lines: line('250gm') })), /Only Admin may select 250 GM/);
  for (const [unitId, expected] of [['kg', 10000], ['500gm', 6000], ['250gm', 3500]]) {
    const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: line(unitId) }));
    const saved = (await db.doc(`orders/${orderId}`).get()).data();
    assert.equal(saved.lines[0].orderUnitId, unitId);
    assert.equal(saved.lines[0].unitPricePaise, expected);
    assert.equal(saved.grandTotal, expected);
  }
  await db.doc('items/itemA').update({ sellingPrice500Gm: null });
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: line('500gm') })), /Item selling price/);
});

test('same item can be ordered in different units while matching units remain duplicates', async () => {
  await db.doc('items/itemA').update({ sellingPrice500Gm: 60 });
  await db.doc('units/orderHalf').set({ name: '500 GM', symbol: 'gm', active: true });
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, assignedUserId: 'userA' });
  const lines = [
    { kind: 'item', productId: 'itemA', quantityQty: 1000, unitId: 'kg' },
    { kind: 'item', productId: 'itemA', quantityQty: 1000, unitId: '500gm' },
  ];
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines }));
  const saved = (await db.doc(`orders/${orderId}`).get()).data();
  assert.deepEqual(saved.lines.map((line) => line.orderUnitName), ['KG', '500 GM']);
  assert.equal(saved.grandTotal, 16000);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().stockDeductions[0].quantityQty, 1500);
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [lines[1], { ...lines[1], unitId: 'orderHalf' }] })), /duplicate order lines with the same unit/);
});

test('order unit selection keeps catalog price, totals, stock and invoice snapshots', async () => {
  await Promise.all([
    db.doc('units/orderKg').set({ name: '1 KG', symbol: 'kg', active: true }),
    db.doc('units/orderHalf').set({ name: '500 GM', symbol: 'gm', active: true }),
    db.doc('units/orderQuarter').set({ name: '250 GM', symbol: 'gm', active: true }),
    db.doc('units/orderInactive').set({ name: '500 GM', symbol: 'gm', active: false }),
  ]);
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, assignedUserId: 'userA' });
  const makeOrder = (unitId, extra = {}) => regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 2000, unitId }], ...extra });
  for (const role of ['accountA', 'userA']) {
    await assert.rejects(saveOrderDraft(db, role, makeOrder('orderQuarter', { assignedUserId: undefined })), /Only Admin may select 250 GM/);
  }
  await assert.rejects(saveOrderDraft(db, 'adminA', makeOrder('orderInactive')), /active order unit/);
  await assert.rejects(saveOrderDraft(db, 'adminA', makeOrder('missing')), /active order unit/);
  const { orderId } = await saveOrderDraft(db, 'adminA', makeOrder('orderHalf'));
  let saved = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(saved.lines[0].orderUnitId, 'orderHalf');
  assert.equal(saved.lines[0].orderUnitName, '500 GM');
  assert.equal(saved.lines[0].unitPricePaise, 10000);
  assert.equal(saved.grandTotal, 20000);
  await saveOrderDraft(db, 'adminA', makeOrder('orderQuarter', { orderId }));
  saved = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(saved.lines[0].orderUnitName, '250 GM');
  assert.equal(saved.lines[0].unitPricePaise, 10000);
  assert.equal(saved.grandTotal, 20000);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 4500);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 4500);
  await createInvoiceFromOrder(db, 'adminA', orderId);
  const invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(invoice.lines[0].unit, '250 GM');
  assert.equal(invoice.lines[0].unitPricePaise, 10000);
  assert.equal(invoice.totalPaise, 20000);
  assert.equal((await db.collection('units').get()).size, 5);
});

test('Admin edits a confirmed order; User invoices it without another stock deduction', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /Only Admin may edit a confirmed order/);
  await assert.rejects(saveOrderDraft(db, 'accountA', regularOrder(customerId, { orderId })), /Only Admin may edit a confirmed order/);
  await saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId, notes: 'Changed before invoice', lines: [{ kind: 'item', productId: 'itemA', quantityQty: 3000 }] }));
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 2000);
  await assert.rejects(createInvoiceFromOrder(db, 'userB', orderId), /only your own order/);
  await createInvoiceFromOrder(db, 'userA', orderId);
  const order = (await db.doc(`orders/${orderId}`).get()).data();
  const invoice = (await db.doc(`invoices/${orderId}`).get()).data();
  assert.equal(order.status, 'confirmed');
  assert.equal(order.invoiceId, orderId);
  assert.ok(order.editLockedAt);
  assert.equal(order.stockDeductions[0].quantityQty, 3000);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 2000);
  assert.equal(invoice.totalPaise, order.grandTotal);
  assert.equal(invoice.createdBy, 'userA');
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /invoice exists/);
  await assert.rejects(createInvoiceFromOrder(db, 'userA', orderId), /already exists/);
});

test('Admin, Account Admin, and assigned User invoice confirmed orders once', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, assignedUserId: 'userA' });
  for (const [creator, issuer, assignedUserId] of [['adminA', 'adminA', 'adminA'], ['accountA', 'accountA', 'accountA'], ['userA', 'userA', undefined]]) {
    const input = regularOrder(customerId, { assignedUserId, lines: [{ kind: 'item', productId: 'itemA', quantityQty: 1000 }] });
    const created = await saveOrderDraft(db, creator, input);
    assert.equal(created.status, 'confirmed');
    const stockBeforeInvoice = (await db.doc('inventory/itemA').get()).data().onHandQty;
    const concurrent = issuer === 'adminA' ? await Promise.allSettled([createInvoiceFromOrder(db, issuer, created.orderId), createInvoiceFromOrder(db, issuer, created.orderId)]) : null;
    if (concurrent) assert.equal(concurrent.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const result = concurrent ? concurrent.find((attempt) => attempt.status === 'fulfilled').value : await createInvoiceFromOrder(db, issuer, created.orderId);
    assert.equal(result.invoiceId, created.orderId);
    assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, stockBeforeInvoice);
    assert.equal((await db.doc(`invoices/${created.orderId}`).get()).data().invoiceNumber, `INV-${created.orderNumber}`);
    await assert.rejects(createInvoiceFromOrder(db, issuer, created.orderId), /already exists/);
    await assert.rejects(saveOrderDraft(db, 'adminA', { ...input, orderId: created.orderId }), /invoice exists/);
    assert.equal((await db.collection('invoices').where('orderId', '==', created.orderId).get()).size, 1);
    const events = (await db.collection('auditLogs').where('referenceId', '==', created.orderId).get()).docs.map((doc) => doc.data());
    assert.equal(events.filter((event) => event.type === 'invoice.created').length, 1);
    assert.equal(events.filter((event) => event.type === 'order.locked').length, 1);
  }
});

test('legacy Draft remains Draft until explicitly confirmed and cannot be invoiced first', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await makeLegacyDraft(orderId);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'draft');
  await assert.rejects(createInvoiceFromOrder(db, 'adminA', orderId), /Only a Confirmed order/);
  await confirmOrder(db, 'userA', orderId);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'confirmed');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
});

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

test('new order confirms and debits stock once with movement, customer link and audit', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId, orderNumber } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  assert.match(orderNumber, /^SS-2026-\d{6}$/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  const linked = (await db.doc(`customers/${customerId}`).get()).data();
  assert.deepEqual(linked.ownerUserIds, ['userA']); assert.equal(linked.orderLinks.userA, orderId);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'confirmed');
  const move = (await db.doc(`inventoryMovements/order_${orderId}_itemA`).get()).data();
  assert.equal(move.changeQty, -2000); assert.equal(move.ownerUid, 'userA');
  await assert.rejects(confirmOrder(db, 'userA', orderId), /Only a draft/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  const events = (await db.collection('auditLogs').where('referenceId', '==', orderId).get()).docs.map((doc) => doc.data());
  assert.deepEqual(events.map((event) => event.type).sort(), ['order.confirmed', 'order.created']);
  assert.ok(events.every((event) => event.actorUid === 'adminA' && event.actorName === 'Admin' && event.customerId === customerId && event.at));
});

test('new orders and confirmed edits require enough stock for every item and special component', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await db.doc('inventory/itemA').update({ onHandQty: 0 });
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId)), /Insufficient available stock for Sweet A/);
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId, notes: 'Changed', lines: [{ kind: 'item', productId: 'itemA', quantityQty: 3000 }] })), /Insufficient available stock/);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().notes, '');
  await db.doc('inventory/itemA').update({ onHandQty: 1000 });
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId)), /Insufficient available stock for Sweet A/);
  const { specialId } = await saveSpecialProduct(db, 'adminA', { name: 'Combo', description: '', finalPricePaise: 30000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] });
  await db.doc('inventory/itemA').update({ onHandQty: 5000 });
  await db.doc('inventory/itemB').update({ onHandQty: 0 });
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'special', productId: specialId, quantityQty: 1000 }] })), /Insufficient available stock for Sweet B/);
});

test('special recipe deducts all underlying components and preserves snapshot', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { specialId } = await saveSpecialProduct(db, 'accountA', { name: 'Festive box', description: '', finalPricePaise: 50000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 250 }] });
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 1000 }, { kind: 'special', productId: specialId, quantityQty: 2000 }] }));
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  assert.equal((await db.doc('inventory/itemB').get()).data().onHandQty, 2500);
  const before = (await db.doc(`orders/${orderId}`).get()).data().lines[1].specialSnapshot;
  await saveSpecialProduct(db, 'adminA', { specialId, name: 'Festive box v2', description: '', finalPricePaise: 60000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 750 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] });
  assert.deepEqual((await db.doc(`orders/${orderId}`).get()).data().lines[1].specialSnapshot, before);
});

test('only Admin may create, edit, or confirm special orders; assignee remains the owner', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { specialId } = await saveSpecialProduct(db, 'adminA', { name: 'Festive box', description: '', finalPricePaise: 50000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 250 }] });
  const specialOrder = regularOrder(customerId, { lines: [{ kind: 'special', productId: specialId, quantityQty: 1000 }] });
  await assert.rejects(saveOrderDraft(db, 'accountA', specialOrder), /Only Admin/);
  await assert.rejects(saveOrderDraft(db, 'userA', specialOrder), /Only Admin/);
  const { orderId } = await saveOrderDraft(db, 'adminA', specialOrder);
  const saved = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(saved.ownerUid, 'userA');
  assert.equal(saved.assignedUserId, 'userA');
  assert.equal(saved.lines[0].specialSnapshot.name, 'Festive box');
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /Only Admin/);
  await assert.rejects(saveOrderDraft(db, 'accountA', regularOrder(customerId, { orderId })), /Only Admin/);
  await assert.rejects(confirmOrder(db, 'userA', orderId), /Only a draft/);
  await assert.rejects(confirmOrder(db, 'accountA', orderId), /Only a draft/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 4500);
  await assert.rejects(archiveOrder(db, 'userA', { orderId }), /view special orders/);
  await assert.rejects(requestOrderPayment(db, 'userA', { orderId }), /view special orders/);
  await assert.rejects(cancelOrder(db, 'userA', orderId, 'No longer needed'), /view special orders/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 4500);
  await createInvoiceFromOrder(db, 'userA', orderId);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 4500);
});

test('global pause, item block and stale price prevent confirmation', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await makeLegacyDraft(orderId);
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

test('blocking preserves an already confirmed order and its stock history', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const first = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  const before = (await db.doc('inventory/itemA').get()).data().onHandQty;
  const movements = (await db.collection('inventoryMovements').get()).size;
  await setInventoryControl(db, 'adminA', { itemId: 'itemA', sellingBlocked: true, lowStockThresholdQty: 1000, reason: 'Quality hold' });
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, before);
  assert.equal((await db.collection('inventoryMovements').get()).size, movements);
  assert.equal((await db.doc(`orders/${first.orderId}`).get()).data().status, 'confirmed');
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId)), /blocked/);
});

test('edited special recipe makes an existing draft stale', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const recipe = { name: 'Combo', description: '', finalPricePaise: 30000, active: true, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 500 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] };
  const { specialId } = await saveSpecialProduct(db, 'adminA', recipe);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'special', productId: specialId, quantityQty: 1000 }] }));
  await makeLegacyDraft(orderId);
  await saveSpecialProduct(db, 'adminA', { ...recipe, specialId, components: [{ itemId: 'itemA', unitId: 'kg', quantityQty: 750 }, { itemId: 'itemB', unitId: 'kg', quantityQty: 500 }] });
  await assert.rejects(confirmOrder(db, 'adminA', orderId), /price or recipe changed/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
});

test('two competing orders cannot oversell', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const make = () => saveOrderDraft(db, 'adminA', regularOrder(customerId, { lines: [{ kind: 'item', productId: 'itemA', quantityQty: 4000 }] }));
  const results = await Promise.allSettled([make(), make()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 1000);
  assert.equal((await db.collection('inventoryMovements').get()).size, 1);
});

test('cancellation restores once; delivered and invoiced orders cannot use ordinary cancellation', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const first = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  const cancellations = await Promise.allSettled([cancelOrder(db, 'accountA', first.orderId, 'Customer changed mind'), cancelOrder(db, 'adminA', first.orderId, 'Customer changed mind')]);
  assert.equal(cancellations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
  await assert.rejects(cancelOrder(db, 'accountA', first.orderId, 'Again'), /cannot be cancelled/);
  const second = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await assert.rejects(createInvoiceFromOrder(db, 'userB', second.orderId), /only your own order/);
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

test('archived confirmed cancellation restores deducted stock once and keeps archive history', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await archiveOrder(db, 'adminA', { orderId, reason: 'Held for review' });
  const archivedAt = (await db.doc(`orders/${orderId}`).get()).data().archivedAt.toMillis();
  const results = await Promise.allSettled([
    cancelOrder(db, 'adminA', orderId, 'Customer cancelled'),
    cancelOrder(db, 'accountA', orderId, 'Customer cancelled'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const order = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(order.status, 'cancelled');
  assert.equal(order.archivedAt.toMillis(), archivedAt);
  assert.ok(order.cancelledAt);
  assert.ok(['adminA', 'accountA'].includes(order.cancelledBy));
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
  assert.equal((await db.doc(`inventoryMovements/order_reversal_${orderId}_itemA`).get()).data().changeQty, 2000);
  const events = (await db.collection('auditLogs').where('referenceId', '==', orderId).get()).docs.map((doc) => doc.data());
  assert.ok(events.some((event) => event.type === 'order.archived'));
  assert.equal(events.filter((event) => event.type === 'order.cancelled').length, 1);
  assert.deepEqual(events.find((event) => event.type === 'order.cancelled').detail.changedFields.inventory.items, [{ itemId: 'itemA', itemName: 'Sweet A', unitSymbol: 'kg', onHandQtyRestored: 2000 }]);
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId })), /Draft or Confirmed/);
  await assert.rejects(advanceOrder(db, 'adminA', orderId, 'in_preparation'), /Invalid order status/);
  await assert.rejects(restoreOrder(db, 'adminA', { orderId }), /cannot be archived or restored/);
});

test('archived legacy reservation releases available stock without adding on-hand stock', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  const [reservation] = (await db.doc(`orders/${orderId}`).get()).data().stockDeductions;
  await makeLegacyDraft(orderId);
  await db.doc('inventory/itemA').update({ reservedQty: 2000 });
  await db.doc(`orders/${orderId}`).update({ stockReservations: [reservation] });
  await archiveOrder(db, 'adminA', { orderId });
  await cancelOrder(db, 'userA', orderId, 'No longer needed');
  const stock = (await db.doc('inventory/itemA').get()).data();
  assert.equal(stock.onHandQty, 5000);
  assert.equal(stock.reservedQty, 0);
  const movement = (await db.doc(`inventoryMovements/order_reservation_release_${orderId}_itemA`).get()).data();
  assert.equal(movement.changeQty, 0);
  assert.equal(movement.reservedChangeQty, -2000);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'cancelled');
  await assert.rejects(cancelOrder(db, 'userA', orderId, 'Again'), /cannot be cancelled/);
  assert.equal((await db.doc('inventory/itemA').get()).data().reservedQty, 0);
});

test('archived draft without stock movement cancels without changing inventory', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await makeLegacyDraft(orderId);
  await archiveOrder(db, 'userA', { orderId });
  await cancelOrder(db, 'userA', orderId, 'No longer needed');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 5000);
  assert.equal((await db.collection('inventoryMovements').get()).size, 0);
  const event = (await db.collection('auditLogs').where('type', '==', 'order.draft_cancelled').get()).docs[0].data();
  assert.equal(event.detail.changedFields.inventory.kind, 'none');
});

test('archived cancellation keeps backend authorization and financial locks', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await archiveOrder(db, 'adminA', { orderId });
  await assert.rejects(cancelOrder(db, 'userA', orderId, 'Try'), /Only staff/);
  await db.doc(`invoices/${orderId}`).set({ orderId, paymentStatus: 'unpaid' });
  await assert.rejects(cancelOrder(db, 'adminA', orderId, 'Try'), /credit or return/);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'confirmed');
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  await db.doc(`invoices/${orderId}`).delete();
  await db.doc('payments/locked').set({ orderId, amountPaise: 100 });
  await assert.rejects(cancelOrder(db, 'adminA', orderId, 'Try'), /payment history/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
});

test('ambiguous reservation state blocks archived cancellation without changing stock', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await makeLegacyDraft(orderId);
  await db.doc('inventory/itemA').update({ reservedQty: 2000 });
  await db.doc(`orders/${orderId}`).update({ status: 'confirmed' });
  await archiveOrder(db, 'adminA', { orderId });
  await assert.rejects(cancelOrder(db, 'adminA', orderId, 'No stock recorded'), /stock state needs review/);
  assert.equal((await db.doc('inventory/itemA').get()).data().reservedQty, 2000);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'confirmed');
});

test('User can create own customer with confirmed order but cannot edit or cancel it', async () => {
  const { orderId, customerId } = await saveOrderDraft(db, 'userA', { ...regularOrder(null), customerId: undefined, newCustomer: customer });
  assert.equal((await db.doc(`customers/${customerId}`).get()).data().assignedUserId, 'userA');
  assert.equal((await db.doc(`customers/${customerId}`).get()).data().orderLinks.userA, orderId);
  await assert.rejects(saveOrderDraft(db, 'userB', regularOrder(customerId, { assignedUserId: 'userB' })), /assigned to your account/);
  await assert.rejects(cancelOrder(db, 'userB', orderId, 'No'), /Only staff/);
  await assert.rejects(cancelOrder(db, 'userA', orderId, 'No longer needed'), /Only staff/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
});

test('assigned customer is reused in orders and keeps historical invoice reference after reassignment', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', { ...customer, assignedUserId: 'userA' });
  const { orderId } = await saveOrderDraft(db, 'userA', regularOrder(customerId, { assignedUserId: undefined }));
  assert.equal((await db.collection('customers').get()).size, 1);
  await createInvoiceFromOrder(db, 'userA', orderId);
  await saveCustomer(db, 'adminA', { ...customer, customerId, assignedUserId: 'userB' });
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { assignedUserId: undefined })), /assigned to your account/);
  const reassigned = await saveOrderDraft(db, 'userB', regularOrder(customerId, { assignedUserId: undefined }));
  assert.equal((await db.doc(`orders/${reassigned.orderId}`).get()).data().customerId, customerId);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().customerId, customerId);
  assert.equal((await db.doc(`invoices/${orderId}`).get()).data().customerId, customerId);
  assert.equal((await db.collection('customers').get()).size, 1);
});

test('only Admin assigns new orders; confirmed owners remain immutable', async () => {
  const {customerId} = await saveCustomer(db, 'adminA', customer);
  await db.doc('inventory/itemA').update({ onHandQty: 10000 });
  for (const assignedUserId of ['adminA', 'accountA', 'userA']) {
    const result = await saveOrderDraft(db, 'adminA', {...regularOrder(customerId), assignedUserId});
    assert.equal((await db.doc('orders/'+result.orderId).get()).data().ownerUid, assignedUserId);
  }
  await assert.rejects(saveOrderDraft(db, 'accountA', regularOrder(customerId)), /only Admin/);
  const own = await saveOrderDraft(db, 'accountA', {...regularOrder(customerId), assignedUserId: 'accountA'});
  await assert.rejects(saveOrderDraft(db, 'accountA', {...regularOrder(customerId), orderId: own.orderId, assignedUserId: 'accountA'}), /Only Admin may edit a confirmed order/);
  await assert.rejects(saveOrderDraft(db, 'adminA', {...regularOrder(customerId), orderId: own.orderId}), /ownership/);
  await assert.rejects(saveOrderDraft(db, 'userA', {...regularOrder(customerId), assignedUserId: 'userB'}), /only Admin/);
  await db.doc('users/userB').update({active:false});
  await assert.rejects(saveOrderDraft(db, 'adminA', {...regularOrder(customerId), assignedUserId:'userB'}), /active OMS/);
  await db.doc('users/userB').update({active:true,role:'invalid'});
  await assert.rejects(saveOrderDraft(db, 'adminA', {...regularOrder(customerId), assignedUserId:'userB'}), /active OMS/);
});

test('only Admin edits a confirmed order with one atomic stock correction and field-level audit', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await assert.rejects(saveOrderDraft(db, 'userB', regularOrder(customerId, { orderId })), /own order/);
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /Only Admin may edit a confirmed order/);
  await saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId, notes: 'Revised', lines: [{ kind: 'item', productId: 'itemA', quantityQty: 3000 }] }));
  const saved = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.grandTotal, 30000);
  assert.equal(saved.stockDeductions[0].quantityQty, 3000);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 2000);
  assert.equal((await db.doc(`inventoryMovements/order_edit_${orderId}_1_itemA`).get()).data().changeQty, -1000);
  const auditRows = await db.collection('auditLogs').where('referenceId', '==', orderId).get();
  const edited = auditRows.docs.find((snap) => snap.data().type === 'order.edited').data();
  assert.equal(edited.actorName, 'Admin');
  assert.equal(edited.customerName, customer.fullName);
  assert.deepEqual(edited.detail.changedFields.notes, { before: '', after: 'Revised' });
  const beforeCount = auditRows.size;
  await assert.rejects(saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId, lines: [{ kind: 'item', productId: 'itemA', quantityQty: 6000 }] })), /Insufficient available stock/);
  assert.equal((await db.collection('auditLogs').where('referenceId', '==', orderId).get()).size, beforeCount);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 2000);
});

test('invoice creation and confirmed edit serialize; invoices lock later edits and archives', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  const concurrent = await Promise.allSettled([
    saveOrderDraft(db, 'adminA', regularOrder(customerId, { orderId, notes: 'Changed', lines: [{ kind: 'item', productId: 'itemA', quantityQty: 3000 }] })),
    createInvoiceFromOrder(db, 'accountA', orderId),
  ]);
  // Both may succeed when the edit commits before invoice creation. The final
  // invoice must still match the committed order, and later edits must fail.
  assert.ok(concurrent.some((result) => result.status === 'fulfilled'));
  if (!(await db.doc(`invoices/${orderId}`).get()).exists) await createInvoiceFromOrder(db, 'accountA', orderId);
  assert.equal((await db.doc(`invoices/${orderId}`).get()).data().paymentStatus, 'unpaid');
  assert.equal((await listOrderActivity(db, 'userA', { filters: { order: orderId, type: 'order.locked' } })).rows.length, 1);
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /invoice exists/);
  await assert.rejects(archiveOrder(db, 'userA', { orderId }), /invoice exists/);
  assert.equal((await db.doc(`invoices/${orderId}`).get()).data().totalPaise, (await db.doc(`orders/${orderId}`).get()).data().grandTotal);
});

test('archive retains stock and reporting status; payment request keeps edits available', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  await assert.rejects(archiveOrder(db, 'userB', { orderId }), /own order/);
  await archiveOrder(db, 'userA', { orderId, reason: 'Hold for review' });
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'confirmed');
  assert.ok((await db.doc(`orders/${orderId}`).get()).data().archivedAt);
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /Restore/);
  await assert.rejects(createInvoiceFromOrder(db, 'accountA', orderId), /Restore/);
  await restoreOrder(db, 'accountA', { orderId });
  await requestOrderPayment(db, 'userA', { orderId });
  await assert.rejects(requestOrderPayment(db, 'userA', { orderId }), /already/);
  await assert.rejects(saveOrderDraft(db, 'userA', regularOrder(customerId, { orderId })), /Only Admin may edit a confirmed order/);
  await assert.rejects(archiveOrder(db, 'userA', { orderId }), /payment was requested/);
  assert.equal((await db.doc('inventory/itemA').get()).data().onHandQty, 3000);
  const history = await listOrderActivity(db, 'userA', { filters: { order: orderId } });
  assert.deepEqual(history.rows.slice(0, 3).map((row) => row.type), ['order.payment_requested', 'order.restored', 'order.archived']);
  assert.deepEqual(history.rows.slice(3).map((row) => row.type).sort(), ['order.confirmed', 'order.created']);
  assert.equal(history.rows[2].reason, 'Hold for review');
  assert.equal(history.rows[2].customerName, customer.fullName);
  assert.equal((await listOrderActivity(db, 'userB', { filters: { order: orderId } })).rows.length, 0);
});

test('archive versus payment request allows one winner and stock visibility remains read only', async () => {
  const { customerId } = await saveCustomer(db, 'adminA', customer);
  const { orderId } = await saveOrderDraft(db, 'adminA', regularOrder(customerId));
  const results = await Promise.allSettled([archiveOrder(db, 'userA', { orderId }), requestOrderPayment(db, 'userA', { orderId })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const stock = await getOrderStock(db, 'userA', { itemIds: ['itemA', 'itemB'] });
  assert.equal(stock.items[0].availableQty, 3000);
  assert.equal(stock.items[0].unit, 'kg');
  assert.equal(stock.items[0].reservedQty, 0);
  await db.doc('inventory/itemB').delete();
  assert.equal((await getOrderStock(db, 'userA', { itemIds: ['itemB'] })).items[0].status, 'unavailable');
  await db.doc('users/userB').update({ active: false });
  await assert.rejects(getOrderStock(db, 'userB', { itemIds: ['itemA'] }), /Active OMS/);
});
