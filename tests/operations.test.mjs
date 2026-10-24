import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
import { savePurchaseDraft, confirmPurchase, cancelPurchase, adjustStock, setInventoryControl } from '../functions/operations.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through the Firestore emulator.');
const app = initializeApp({ projectId: 'demo-independent-purchase-tests' }, 'operations-test');
const db = getFirestore(app);
const itemId = 'sweetA';

test.beforeEach(async () => {
  const collections = ['users', 'items', 'units', 'purchaseTypes', 'purchases', 'inventory', 'inventoryMovements', 'stockOperations', 'auditLogs'];
  for (const name of collections) { const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); } }
  await Promise.all([
    db.doc('users/adminA').set({ role: 'admin', active: true, displayName: 'Admin' }),
    db.doc('users/opsAdmin').set({ role: 'admin', active: true, displayName: 'Operations Admin' }),
    db.doc('users/accountA').set({ role: 'account_admin', active: true, displayName: 'Accounts' }),
    db.doc('users/userA').set({ role: 'user', active: true, displayName: 'User' }),
    db.doc(`items/${itemId}`).set({ itemCode: 'SWEET01', name: 'Sweet A', active: true, defaultUnitId: 'kg' }),
    db.doc('units/kg').set({ name: 'Kilogram', symbol: 'kg', active: true }),
    db.doc('purchaseTypes/local').set({ name: 'Local', active: true }),
  ]);
});
test.after(async () => { await deleteApp(app); });

const draft = { quantity: '2.5', unit: 'kg', supplierName: 'Supplier A', purchaseDate: '2026-10-10', purchaseTypeId: 'local', notes: '', documentUrl: '', totalPaise: 30000, paidAmountPaise: 0 };
const assertNoStock = async () => {
  assert.equal((await db.collection('inventory').get()).size, 0);
  assert.equal((await db.collection('inventoryMovements').get()).size, 0);
};
test('purchase create, edit, confirm and cancel never touch stock or require items', async () => {
  await db.doc('items/' + itemId).delete(); await db.doc('units/kg').delete();
  const { purchaseId } = await savePurchaseDraft(db, 'adminA', draft);
  await savePurchaseDraft(db, 'accountA', { ...draft, purchaseId, quantity: ' 7.125 ', unit: ' boxes ', totalPaise: 40000, paidAmountPaise: 10000, paymentMode: 'upi', paymentReference: 'UPI-001' });
  const saved = (await db.doc('purchases/' + purchaseId).get()).data();
  assert.equal(saved.quantity, '7.125'); assert.equal(saved.unit, 'boxes'); assert.equal(saved.paymentStatus, 'partial'); assert.equal(saved.totalPaise, 40000); assert.equal(saved.createdBy, 'adminA'); assert.equal(saved.lines, undefined);
  await confirmPurchase(db, 'accountA', purchaseId);
  await assert.rejects(confirmPurchase(db, 'adminA', purchaseId), /Only a draft/);
  await assert.rejects(savePurchaseDraft(db, 'adminA', { ...draft, purchaseId }), /Only draft/);
  await cancelPurchase(db, 'adminA', purchaseId, 'Duplicate expense');
  await assert.rejects(cancelPurchase(db, 'adminA', purchaseId, 'Again'), /cannot be cancelled/);
  await assertNoStock();
  assert.equal((await db.collection('auditLogs').get()).size, 4);
});
test('simultaneous confirmations change purchase status once without stock movements', async () => {
  const { purchaseId } = await savePurchaseDraft(db, 'adminA', draft);
  const results = await Promise.allSettled([confirmPurchase(db, 'adminA', purchaseId), confirmPurchase(db, 'accountA', purchaseId)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assertNoStock();
});
test('legacy lines and historical inventory survive draft edits and cancellation unchanged', async () => {
  const lines = [{ itemId, quantityQty: 2500, unitCostPaise: 12000, itemSnapshot: { name: 'Historical sweet' } }];
  const {quantity: ignoredQuantity, unit: ignoredUnit, ...legacyDraft} = draft;
  await db.doc('purchases/legacy').set({ ...legacyDraft, lines, status: 'draft', createdBy: 'adminA', createdAt: new Date(0) });
  const originalLegacy = (await db.doc('purchases/legacy').get()).data();
  assert.equal(originalLegacy.quantity, undefined);
  assert.equal(originalLegacy.unit, undefined);
  assert.equal((await db.doc('purchases/legacy').get()).data().quantity, undefined);
  assert.equal((await db.doc('purchases/legacy').get()).data().unit, undefined);
  await db.doc('inventory/' + itemId).set({ onHandQty: 2500, reservedQty: 0 });
  await db.doc('inventoryMovements/historical').set({ movementType: 'purchase_confirm', changeQty: 2500 });
  await savePurchaseDraft(db, 'accountA', { ...draft, purchaseId: 'legacy' });
  assert.equal((await db.doc('purchases/legacy').get()).data().unit, 'kg');
  assert.deepEqual((await db.doc('purchases/legacy').get()).data().lines, lines);
  await confirmPurchase(db, 'adminA', 'legacy');
  await cancelPurchase(db, 'accountA', 'legacy', 'Cancelled expense');
  assert.equal((await db.doc('inventory/' + itemId).get()).data().onHandQty, 2500);
  assert.equal((await db.collection('inventoryMovements').get()).size, 1);
});
test('payment totals, modes, references and old item payloads are validated', async () => {
  for (const change of [{totalPaise:-1}, {totalPaise:1.2}, {paidAmountPaise:30001}, {paidAmountPaise:1,paymentMode:'pending'}, {paidAmountPaise:1,paymentMode:'upi',paymentReference:''}, {lines:[]}]) await assert.rejects(savePurchaseDraft(db,'adminA',{...draft,...change}));
  const { purchaseId } = await savePurchaseDraft(db,'adminA',{...draft,paidAmountPaise:30000,paymentMode:'cash'});
  const saved=(await db.doc('purchases/'+purchaseId).get()).data(); assert.equal(saved.paymentStatus,'paid'); assert.equal(saved.paymentReference,'-');
  const cancelled=await savePurchaseDraft(db,'adminA',draft); await cancelPurchase(db,'accountA',cancelled.purchaseId,'Unused draft'); await assertNoStock();
});

test('adjustment records trusted previous stock and idempotent retry', async () => {
  await db.doc(`inventory/${itemId}`).set({ onHandQty: 1000, reservedQty: 0 });
  const input = { itemId, countedQty: 3200, reason: 'Physical count', operationId: 'count001' };
  await adjustStock(db, 'accountA', input);
  assert.equal((await db.doc('inventoryMovements/adjustment_count001').get()).data().previousQty, 1000);
  assert.equal((await adjustStock(db, 'accountA', input)).repeated, true);
  assert.equal((await db.doc(`inventory/${itemId}`).get()).data().onHandQty, 3200);
  await assert.rejects(adjustStock(db, 'accountA', { ...input, countedQty: 0 }), /already used/);
  const move = (await db.doc('inventoryMovements/adjustment_count001').get()).data();
  assert.equal(move.actorName, 'Accounts');
  const event = (await db.collection('auditLogs').where('type', '==', 'inventory.adjusted').get()).docs[0].data();
  assert.equal(event.actorName, 'Accounts');
  assert.equal(event.detail.previousQty, 1000);
  assert.equal(event.detail.newQty, 3200);
});

test('stale and concurrent physical counts cannot silently overwrite one another', async () => {
  await db.doc(`inventory/${itemId}`).set({ onHandQty: 1000, reservedQty: 0 });
  const inputs = [
    { itemId, countedQty: 2000, expectedOnHandQty: 1000, reason: 'Count A', operationId: 'countA' },
    { itemId, countedQty: 3000, expectedOnHandQty: 1000, reason: 'Count B', operationId: 'countB' },
  ];
  const results = await Promise.allSettled(inputs.map((input) => adjustStock(db, 'adminA', input)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.collection('inventoryMovements').get()).size, 1);
  assert.equal((await db.collection('stockOperations').get()).size, 1);
  assert.equal((await db.collection('auditLogs').get()).size, 1);
  await assert.rejects(adjustStock(db, 'adminA', { ...inputs[0], operationId: 'lateCount', expectedOnHandQty: 1000 }), /Stock changed/);
});

test('selling block and threshold update do not change stock', async () => {
  await setInventoryControl(db, 'adminA', { itemId, sellingBlocked: true, lowStockThresholdQty: 1500, reason: 'Quality hold' });
  const stock = (await db.doc(`inventory/${itemId}`).get()).data();
  assert.equal(stock.sellingBlocked, true); assert.equal(stock.lowStockThresholdQty, 1500); assert.equal(stock.onHandQty, 0);
  await setInventoryControl(db, 'accountA', { itemId, sellingBlocked: false, lowStockThresholdQty: 1000, reason: 'Released' });
  assert.equal((await db.doc(`inventory/${itemId}`).get()).data().sellingBlocked, false);
  assert.equal((await db.doc(`inventory/${itemId}`).get()).data().onHandQty, 0);
  assert.equal((await db.collection('inventoryMovements').get()).size, 0);
  const audits = (await db.collection('auditLogs').where('type', '==', 'inventory.control_changed').get()).docs.map((doc) => doc.data());
  assert.deepEqual(audits.map((event) => event.actorName).sort(), ['Accounts', 'Admin']);
  assert.ok(audits.every((event) => event.at && event.detail.reason));
  await assert.rejects(setInventoryControl(db, 'accountA', { itemId, sellingBlocked: false, lowStockThresholdQty: 1000, reason: 'Again' }), /No stock control change/);
  await assert.rejects(setInventoryControl(db, 'adminA', { itemId, sellingBlocked: true, lowStockThresholdQty: 1000, expectedSellingBlocked: true, expectedLowStockThresholdQty: 1000, reason: 'Stale dialog' }), /Stock controls changed/);
});

test('normal user cannot use stock or purchase operations; bad Drive links fail', async () => {
  await assert.rejects(savePurchaseDraft(db, 'userA', draft), /Access denied/);
  await assert.rejects(adjustStock(db, 'userA', { itemId, countedQty: 1, reason: 'No', operationId: 'bad' }), /Access denied/);
  await assert.rejects(setInventoryControl(db, 'userA', { itemId, sellingBlocked: true, lowStockThresholdQty: 0, reason: 'No' }), /Access denied/);
  await assert.rejects(savePurchaseDraft(db, 'adminA', { ...draft, documentUrl: 'https://evil.example/file' }), /Google Drive/);
});

test('operational Admin can create purchases but cannot change physical stock', async () => {
  const { purchaseId } = await savePurchaseDraft(db, 'opsAdmin', draft);
  assert.ok(purchaseId);
  await assert.rejects(adjustStock(db, 'opsAdmin', { itemId, countedQty: 1000, reason: 'Unauthorized count', operationId: 'adminCount' }), /Access denied/);
  await assert.rejects(setInventoryControl(db, 'opsAdmin', { itemId, sellingBlocked: true, lowStockThresholdQty: 0, reason: 'Unauthorized block' }), /Access denied/);
});

test('purchase quantity is required text; manually entered units are independent of stock', async () => {
  for (const quantity of [undefined, null, '', '   ', '0', '-1', 'x'.repeat(121)]) await assert.rejects(savePurchaseDraft(db, 'adminA', {...draft, quantity}), /quantity/i);
  for (const unit of ['kg', 'boxes', 'pieces', 'litres', 'lots', ' custom unit ']) {
    const { purchaseId } = await savePurchaseDraft(db, 'adminA', {...draft, quantity: ' approx. 12.5 ', unit});
    const saved = (await db.doc(`purchases/${purchaseId}`).get()).data();
    assert.equal(saved.quantity, 'approx. 12.5');
    assert.equal(saved.unit, unit.trim());
    assert.equal(saved.totalPaise, draft.totalPaise);
  }
  await assert.rejects(savePurchaseDraft(db, 'adminA', {...draft, unit: 'x'.repeat(81)}), /Unit/);
  const { purchaseId: noUnitId } = await savePurchaseDraft(db, 'adminA', {...draft, unit: undefined});
  assert.equal((await db.doc(`purchases/${noUnitId}`).get()).data().unit, '');
  await assertNoStock();
});
