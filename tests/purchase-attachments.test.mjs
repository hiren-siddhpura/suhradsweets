import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { savePurchaseDraft, readPurchaseReceipt } from '../functions/operations.js';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run with demo Firestore and Storage emulators.');
const app = initializeApp({ projectId: 'demo-suh-oms', storageBucket: 'demo-suh-oms.firebasestorage.app' });
const db = getFirestore(app);
let env;
const draft = { purchaseId: 'purchase-proof', quantity: '1', unit: 'box', supplierName: 'Supplier', purchaseDate: '2026-10-31', purchaseTypeId: 'local', notes: '', documentUrl: '', totalPaise: 10000 };
const pdf = Buffer.from('%PDF-1.4\n%%EOF');
test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-suh-oms', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }, storage: { rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8') } });
  await Promise.all([
    db.doc('users/staff').set({ role: 'admin', active: true }), db.doc('users/accounts').set({ role: 'account_admin', active: true }),
    db.doc('users/ordinary').set({ role: 'user', active: true }), db.doc('purchaseTypes/local').set({ name: 'Local', active: true }),
  ]);
});
test.after(async () => { await env?.cleanup(); await deleteApp(app); });

test('private attachment saves, survives edits and downloads only for active staff', async () => {
  const storage = env.authenticatedContext('staff').storage('gs://demo-suh-oms.firebasestorage.app');
  const path = 'purchaseReceipts/staff/purchase-proof/proof.pdf';
  await assertSucceeds(uploadBytes(ref(storage, path), pdf, { contentType: 'application/pdf', customMetadata: { ownerUid: 'staff', purchaseId: 'purchase-proof', originalName: 'bill.pdf' } }));
  await savePurchaseDraft(db, 'staff', { ...draft, attachment: { uploadId: 'proof', extension: 'pdf' } });
  await savePurchaseDraft(db, 'accounts', { ...draft, notes: 'Edited without replacing attachment' });
  assert.equal((await db.doc('purchases/purchase-proof').get()).data().attachment.path, path);
  const receipt = await readPurchaseReceipt(db, 'accounts', { purchaseId: 'purchase-proof' });
  assert.equal(receipt.base64, pdf.toString('base64'));
  await assert.rejects(readPurchaseReceipt(db, 'ordinary', { purchaseId: 'purchase-proof' }), /access is required/);
  await assertFails(getBytes(ref(storage, path)));
});

test('Storage rejects nonstaff, oversize, mismatched MIME and confirmed purchase uploads', async () => {
  const upload = (uid, id, bytes, mime = 'application/pdf') => uploadBytes(ref(env.authenticatedContext(uid).storage('gs://demo-suh-oms.firebasestorage.app'), `purchaseReceipts/${uid}/${id}/proof.pdf`), bytes, { contentType: mime, customMetadata: { ownerUid: uid, purchaseId: id, originalName: 'bill.pdf' } });
  await assertFails(upload('ordinary', 'denied', pdf));
  await assertFails(upload('staff', 'oversize', Buffer.alloc(5 * 1024 * 1024 + 1)));
  await assertFails(upload('staff', 'mismatch', pdf, 'image/png'));
  await db.doc('purchases/confirmed').set({ status: 'confirmed' });
  await assertFails(upload('staff', 'confirmed', pdf));
  const exact = Buffer.alloc(5 * 1024 * 1024); exact.write('%PDF-');
  await assertSucceeds(upload('accounts', 'exact-limit', exact));
});

test('trusted save rejects spoofed file contents and mismatched purchase metadata', async () => {
  for (const [uploadId, bytes, purchaseId] of [['spoof', Buffer.from('invalid'), draft.purchaseId], ['foreign', pdf, 'other']]) {
    await getStorage().bucket().file(`purchaseReceipts/staff/${draft.purchaseId}/${uploadId}.pdf`).save(bytes, { metadata: { contentType: 'application/pdf', metadata: { ownerUid: 'staff', purchaseId, originalName: 'bill.pdf' } } });
    await assert.rejects(savePurchaseDraft(db, 'staff', { ...draft, attachment: { uploadId, extension: 'pdf' } }), /valid JPG|belong/);
  }
});
