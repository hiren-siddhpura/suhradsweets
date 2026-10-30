import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref as browserStorageRef, uploadBytes, getBytes } from 'firebase/storage';
import { submitCollection, reviewCollection, readCollectionReceipt } from '../functions/collection-operations.js';
import { submitPayment, reviewPayment, reversePayment } from '../functions/finance-operations.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run with demo Firestore and Storage emulators.');
const app = initializeApp({ projectId: 'demo-suh-oms', storageBucket: 'demo-suh-oms.firebasestorage.app' });
const db = getFirestore(app);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/GioAAAAASUVORK5CYII=', 'base64');
const storageRules = readFileSync(new URL('../storage.rules', import.meta.url), 'utf8');
const firestoreRules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
let rulesEnvironment;
const cashEntry = { mode: 'cash', transactionNumber: '-', attachment: null };
const rows = [{ invoiceId: 'invoiceA', amountPaise: 3000, paymentIndex: 0 }, { invoiceId: 'invoiceB', amountPaise: 2000, paymentIndex: 0 }];
const input = (operationId, allocations = rows, entries = [cashEntry]) => ({ operationId, allocations, entries, remarks: 'Collected on route' });
async function clear(name) { const snap = await db.collection(name).get(); if (!snap.empty) { const batch = db.batch(); snap.forEach((doc) => batch.delete(doc.ref)); await batch.commit(); } }
test.beforeEach(async () => {
  for (const name of ['users', 'customers', 'orders', 'invoices', 'collections', 'payments', 'paymentReferences', 'auditLogs']) await clear(name);
  await Promise.all([
    db.doc('users/userA').set({ role: 'user', active: true, fullName: 'Karyakarta A' }),
    db.doc('users/userB').set({ role: 'user', active: true, fullName: 'Karyakarta B' }),
    db.doc('users/adminA').set({ role: 'admin', active: true, fullName: 'Admin A' }),
    db.doc('users/accountA').set({ role: 'account_admin', active: true, fullName: 'Account Admin' }),
    db.doc('customers/customerA').set({ fullName: 'Customer A', assignedUserId: 'userA', ownerUserIds: [] }),
    db.doc('customers/customerB').set({ fullName: 'Customer B', assignedUserId: 'userA', ownerUserIds: [] }),
    db.doc('orders/orderA').set({ ownerUid: 'userA', orderNumber: 'ORD-A', customerId: 'customerA', customerSnapshot: { fullName: 'Customer A' } }),
    db.doc('orders/orderB').set({ ownerUid: 'userA', orderNumber: 'ORD-B', customerId: 'customerB', customerSnapshot: { fullName: 'Customer B' } }),
    db.doc('invoices/invoiceA').set({ invoiceNumber: 'INV-A', orderId: 'orderA', orderNumber: 'ORD-A', ownerUid: 'userA', customerId: 'customerA', customerSnapshot: { fullName: 'Customer A' }, totalPaise: 10000, verifiedPaidPaise: 2000, paymentStatus: 'partial' }),
    db.doc('invoices/invoiceB').set({ invoiceNumber: 'INV-B', orderId: 'orderB', orderNumber: 'ORD-B', ownerUid: 'userA', customerId: 'customerB', customerSnapshot: { fullName: 'Customer B' }, totalPaise: 5000, verifiedPaidPaise: 0, paymentStatus: 'unpaid' }),
  ]);
});
test.after(async () => { if (rulesEnvironment) await rulesEnvironment.cleanup(); await deleteApp(app); });

test('one collection spans customers and partial invoices; approval creates linked payments once', async () => {
  const result = await submitCollection(db, 'userA', input('cash-multiple'));
  const before = (await db.doc('invoices/invoiceA').get()).data();
  assert.equal(before.verifiedPaidPaise, 2000);
  const pending = (await db.doc(`collections/${result.collectionId}`).get()).data();
  assert.equal(pending.status, 'pending'); assert.equal(pending.customerCount, 2); assert.equal(pending.totalPaise, 5000);
  assert.equal((await submitCollection(db, 'userA', input('cash-multiple'))).alreadySubmitted, true);
  await assert.rejects(submitCollection(db, 'userA', input('cash-multiple', [{ invoiceId: 'invoiceA', amountPaise: 1000, paymentIndex: 0 }])), /different details/);
  await assert.rejects(reviewCollection(db, 'userB', { collectionId: result.collectionId, decision: 'verified' }), /access is required/);
  await reviewCollection(db, 'adminA', { collectionId: result.collectionId, decision: 'verified' });
  assert.equal((await db.doc('invoices/invoiceA').get()).data().verifiedPaidPaise, 5000);
  assert.equal((await db.doc('invoices/invoiceB').get()).data().verifiedPaidPaise, 2000);
  assert.equal((await db.doc(`collections/${result.collectionId}`).get()).data().approvedPaise, 5000);
  const payments = await db.collection('payments').get();
  assert.equal(payments.size, 2); payments.forEach((payment) => assert.equal(payment.data().collectionId, result.collectionId));
  await assert.rejects(reversePayment(db, 'adminA', { paymentId: payments.docs[0].id, reason: 'Individual reversal' }), /Collection allocations cannot be reversed/);
  assert.equal((await reviewCollection(db, 'adminA', { collectionId: result.collectionId, decision: 'verified' })).alreadyReviewed, true);
});

test('reject leaves balances untouched and a corrected collection can be submitted', async () => {
  const first = await submitCollection(db, 'userA', input('reject-first'));
  await assert.rejects(reviewCollection(db, 'adminA', { collectionId: first.collectionId, decision: 'rejected', reason: '' }), /reason/);
  await reviewCollection(db, 'adminA', { collectionId: first.collectionId, decision: 'rejected', reason: 'Incorrect count' });
  assert.equal((await db.doc('invoices/invoiceA').get()).data().verifiedPaidPaise, 2000);
  assert.equal((await db.collection('payments').get()).size, 0);
  const second = await submitCollection(db, 'userA', input('corrected-second'));
  assert.notEqual(first.collectionId, second.collectionId);
});

test('mixed cash and UPI entries validate receipt and preserve allocation method', async () => {
  const operationId = 'mixed-entries';
  const path = `collectionReceipts/userA/${operationId}/1.pdf`;
  await getStorage().bucket().file(path).save(pdf, { metadata: { contentType: 'application/pdf', metadata: { ownerUid: 'userA', operationId, originalName: 'receipt.pdf' } } });
  const allocations = [{ invoiceId: 'invoiceA', amountPaise: 3000, paymentIndex: 0 }, { invoiceId: 'invoiceB', amountPaise: 2000, paymentIndex: 1 }];
  const entries = [cashEntry, { mode: 'upi', transactionNumber: 'UPI-123', attachment: { extension: 'pdf' } }];
  const result = await submitCollection(db, 'userA', input(operationId, allocations, entries));
  const receipt = await readCollectionReceipt(db, 'userA', { collectionId: result.collectionId, entryIndex: 1 });
  assert.equal(Buffer.from(receipt.base64, 'base64').equals(pdf), true);
  await assert.rejects(readCollectionReceipt(db, 'userB', { collectionId: result.collectionId, entryIndex: 1 }), /access is required/);
  await reviewCollection(db, 'accountA', { collectionId: result.collectionId, decision: 'verified' });
  const payments = (await db.collection('payments').get()).docs.map((snap) => snap.data());
  assert.deepEqual(new Set(payments.map((payment) => payment.mode)), new Set(['cash', 'upi']));
  assert.equal(payments.find((payment) => payment.mode === 'upi').attachment.path, path);
});

test('rejected online transaction ID may be reused in a corrected collection', async () => {
  for (const operationId of ['online-first', 'online-corrected']) await getStorage().bucket().file(`collectionReceipts/userA/${operationId}/0.pdf`).save(pdf, { metadata: { contentType: 'application/pdf', metadata: { ownerUid: 'userA', operationId, originalName: 'receipt.pdf' } } });
  const entries = [{ mode: 'upi', transactionNumber: 'UPI-RETRY', attachment: { extension: 'pdf' } }];
  const first = await submitCollection(db, 'userA', input('online-first', [rows[0]], entries));
  await reviewCollection(db, 'adminA', { collectionId: first.collectionId, decision: 'rejected', reason: 'Wrong allocation' });
  const corrected = await submitCollection(db, 'userA', input('online-corrected', [rows[1]], entries));
  assert.notEqual(first.collectionId, corrected.collectionId);
});

test('duplicate invoice, overpayment and missing online receipt are rejected', async () => {
  await assert.rejects(submitCollection(db, 'userB', input('foreign-invoice', [rows[0]])), /invoice access/);
  await assert.rejects(submitCollection(db, 'userA', input('duplicate', [rows[0], rows[0]])), /unique/);
  await assert.rejects(submitCollection(db, 'userA', input('excess', [{ invoiceId: 'invoiceA', amountPaise: 9000, paymentIndex: 0 }])), /balance/);
  await assert.rejects(submitCollection(db, 'userA', input('missing-proof', [rows[0]], [{ mode: 'upi', transactionNumber: 'UPI-88' }])), /receipt/);
});

test('PNG receipt is accepted, while invalid signatures and oversized files are rejected', async () => {
  const storage = getStorage().bucket();
  await storage.file('collectionReceipts/userA/image-good/0.png').save(png, { metadata: { contentType: 'image/png', metadata: { ownerUid: 'userA', operationId: 'image-good', originalName: 'proof.png' } } });
  const accepted = await submitCollection(db, 'userA', input('image-good', [rows[0]], [{ mode: 'upi', transactionNumber: 'PNG-123', attachment: { extension: 'png' } }]));
  assert.equal((await db.doc(`collections/${accepted.collectionId}`).get()).data().entries[0].attachment.contentType, 'image/png');
  await storage.file('collectionReceipts/userA/image-bad/0.png').save(Buffer.from('not a png'), { metadata: { contentType: 'image/png', metadata: { ownerUid: 'userA', operationId: 'image-bad', originalName: 'fake.png' } } });
  await assert.rejects(submitCollection(db, 'userA', input('image-bad', [rows[0]], [{ mode: 'upi', transactionNumber: 'PNG-124', attachment: { extension: 'png' } }])), /valid JPG, PNG or PDF/);
  await storage.file('collectionReceipts/userA/image-large/0.png').save(Buffer.alloc(5 * 1024 * 1024 + 1), { metadata: { contentType: 'image/png', metadata: { ownerUid: 'userA', operationId: 'image-large', originalName: 'large.png' } } });
  await assert.rejects(submitCollection(db, 'userA', input('image-large', [rows[0]], [{ mode: 'upi', transactionNumber: 'PNG-125', attachment: { extension: 'png' } }])), /5 MB/);
});

test('Storage rules allow owner creation and deny direct reads and foreign uploads', async () => {
  rulesEnvironment ||= await initializeTestEnvironment({ projectId: 'demo-suh-oms', firestore: { rules: firestoreRules }, storage: { rules: storageRules } });
  const ownStorage = rulesEnvironment.authenticatedContext('userA').storage();
  const foreignStorage = rulesEnvironment.authenticatedContext('userB').storage();
  const path = 'collectionReceipts/userA/rules-check/0.png';
  await assertSucceeds(uploadBytes(browserStorageRef(ownStorage, path), png, { contentType: 'image/png', customMetadata: { ownerUid: 'userA', operationId: 'rules-check', originalName: 'proof.png' } }));
  await assertFails(getBytes(browserStorageRef(ownStorage, path)));
  await assertFails(uploadBytes(browserStorageRef(foreignStorage, 'collectionReceipts/userA/foreign-check/0.png'), png, { contentType: 'image/png', customMetadata: { ownerUid: 'userA', operationId: 'foreign-check', originalName: 'proof.png' } }));
  await assertFails(uploadBytes(browserStorageRef(ownStorage, 'collectionReceipts/userA/invalid-type/0.pdf'), png, { contentType: 'image/png', customMetadata: { ownerUid: 'userA', operationId: 'invalid-type', originalName: 'wrong.pdf' } }));
});

test('concurrent approvals cannot allocate twice', async () => {
  const result = await submitCollection(db, 'userA', input('concurrent'));
  const settled = await Promise.allSettled([reviewCollection(db, 'adminA', { collectionId: result.collectionId, decision: 'verified' }), reviewCollection(db, 'accountA', { collectionId: result.collectionId, decision: 'verified' })]);
  assert.ok(settled.some((item) => item.status === 'fulfilled'));
  assert.equal((await db.doc('invoices/invoiceA').get()).data().verifiedPaidPaise, 5000);
  assert.equal((await db.collection('payments').get()).size, 2);
});

test('existing single cash payment flow still verifies independently', async () => {
  const result = await submitPayment(db, 'userA', { invoiceId: 'invoiceA', amountPaise: 1000, mode: 'cash' });
  assert.equal((await db.doc('invoices/invoiceA').get()).data().verifiedPaidPaise, 2000);
  await reviewPayment(db, 'adminA', { paymentId: result.paymentId, decision: 'verified' });
  assert.equal((await db.doc('invoices/invoiceA').get()).data().verifiedPaidPaise, 3000);
  assert.equal((await db.doc(`payments/${result.paymentId}`).get()).data().collectionId, undefined);
});
