import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { customerContactHash, customerSaveError } from '../js/customer-validation.js';

const source = readFileSync(new URL('../js/customer-data.js', import.meta.url), 'utf8')
  .replace('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js', import.meta.resolve('firebase/firestore'))
  .replace('./customer-validation.js', new URL('../js/customer-validation.js', import.meta.url).href);
const { saveCustomerDirect } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let environment;
const dbFor = (uid) => uid ? environment.authenticatedContext(uid).firestore() : environment.unauthenticatedContext().firestore();
const authFor = (uid) => ({ currentUser: uid ? { uid } : null });
const input = { fullName: 'Local Customer', contact: '9876543210', address: 'Local road', area: 'West', dateOfBirth: null, sabha: false };
const save = (uid, id, values = input, create = true) => saveCustomerDirect(dbFor(uid), authFor(uid), values, { customerId: id, create });

test.before(async () => {
  environment = await initializeTestEnvironment({ projectId: 'demo-customer-client-tests', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
});
test.beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    for (const [uid, role, active] of [['admin', 'admin', true], ['account', 'account_admin', true], ['userA', 'user', true], ['userB', 'user', true], ['inactive', 'admin', false]]) {
      await setDoc(doc(context.firestore(), 'users', uid), { role, active, displayName: uid });
    }
  });
});
test.after(async () => environment?.cleanup());

test('Admin and Account Admin create validated customers, reservations and audits without callable services', async () => {
  for (const [uid, contact] of [['admin', '9876543210'], ['account', '9876543211']]) {
    await save(uid, `customer-${uid}`, { ...input, contact, createdBy: 'userA', ownerUserIds: ['userA'], orderLinks: { userA: 'forged' } });
    const data = (await getDoc(doc(dbFor(uid), 'customers', `customer-${uid}`))).data();
    assert.equal(data.createdBy, uid); assert.deepEqual(data.ownerUserIds, []); assert.deepEqual(data.orderLinks, {});
    assert.equal(data.dateOfBirth, null);
    const audit = (await getDoc(doc(dbFor(uid), 'auditLogs', data.lastAuditId))).data();
    assert.equal(audit.actorUid, uid); assert.equal(audit.type, 'customer.created');
    assert.deepEqual(audit.detail.before, null); assert.equal(audit.detail.after.fullName, input.fullName);
    assert.equal((await getDocs(collection(dbFor(uid), 'orders'))).size, 0);
    assert.equal((await getDocs(collection(dbFor(uid), 'inventory'))).size, 0);
  }
});

test('anonymous, inactive, missing-profile and normal User creation is denied', async () => {
  await assert.rejects(save(null, 'anonymous'), /Sign in/);
  for (const uid of ['inactive', 'missing', 'userA']) await assertFails(save(uid, `forbidden-${uid}`));
  await assertFails(saveCustomerDirect(dbFor('userA'), authFor('admin'), input, { customerId: 'spoofed-actor' }));
});

test('duplicate submission retries reuse the same customer and audit; parallel contacts cannot duplicate', async () => {
  await save('admin', 'same-submission');
  assert.equal((await save('admin', 'same-submission')).alreadySaved, true);
  await assert.rejects(save('admin', 'different-id', { ...input, contact: '(987) 654-3210' }), /already exists/);
  assert.equal((await getDocs(collection(dbFor('admin'), 'customers'))).size, 1);
  assert.equal((await getDocs(collection(dbFor('admin'), 'auditLogs'))).size, 1);
  const parallel = await Promise.allSettled(['parallel-a', 'parallel-b'].map((id) => save('admin', id, { ...input, contact: '9988776655' })));
  assert.equal(parallel.filter((entry) => entry.status === 'fulfilled').length, 1);
});

test('Admin import reuses customer reservations and IDs; Account Admin and User import metadata is denied', async () => {
  const importReference = { jobId: 'a'.repeat(64), rowNumber: 2 };
  await saveCustomerDirect(dbFor('admin'), authFor('admin'), { ...input, assignedUserId: 'userA' }, { customerId: 'import-first', importReference });
  assert.equal((await saveCustomerDirect(dbFor('admin'), authFor('admin'), { ...input, assignedUserId: 'userA' }, { customerId: 'import-first', importReference })).alreadySaved, true);
  assert.equal((await getDocs(collection(dbFor('admin'), 'customers'))).size, 1);
  assert.equal((await getDocs(collection(dbFor('admin'), 'auditLogs'))).size, 1);
  const saved = (await getDoc(doc(dbFor('admin'), 'customers', 'import-first'))).data();
  assert.deepEqual((await getDoc(doc(dbFor('admin'), 'auditLogs', saved.lastAuditId))).data().detail.import, importReference);
  await assert.rejects(saveCustomerDirect(dbFor('admin'), authFor('admin'), { ...input, contact: '(987) 654-3210' }, { customerId: 'import-second', importReference: { ...importReference, rowNumber: 3 } }), /already exists/);
  await assertFails(saveCustomerDirect(dbFor('account'), authFor('account'), { ...input, contact: '1111111111' }, { customerId: 'import-account', importReference }));
  await assertFails(saveCustomerDirect(dbFor('userA'), authFor('userA'), { ...input, contact: '2222222222' }, { customerId: 'import-user', importReference }));
  assert.equal((await getDocs(collection(dbFor('admin'), 'customers'))).size, 1);
});

test('Admin import summary audit records only counts and cannot alter orders or invoices', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'orders', 'history'), { customerId: 'historical', status: 'delivered' });
    await setDoc(doc(context.firestore(), 'invoices', 'history'), { customerId: 'historical', paymentStatus: 'paid' });
  });
  const summary = { type: 'customer.import_completed', actorUid: 'admin', referenceType: 'customerImport', referenceId: 'b'.repeat(64), detail: { processed: 2, imported: 1, existing: 1, duplicate: 0, invalid: 0, failed: 0 }, at: serverTimestamp() };
  await assertSucceeds(addDoc(collection(dbFor('admin'), 'auditLogs'), summary));
  await assertFails(addDoc(collection(dbFor('account'), 'auditLogs'), { ...summary, actorUid: 'account' }));
  await assertFails(addDoc(collection(dbFor('userA'), 'auditLogs'), { ...summary, actorUid: 'userA' }));
  await assertFails(addDoc(collection(dbFor('admin'), 'auditLogs'), { ...summary, detail: { ...summary.detail, processed: 9 } }));
  await saveCustomerDirect(dbFor('admin'), authFor('admin'), input, { customerId: 'import-history', importReference: { jobId: 'b'.repeat(64), rowNumber: 2 } });
  assert.equal((await getDoc(doc(dbFor('admin'), 'orders', 'history'))).data().customerId, 'historical');
  assert.equal((await getDoc(doc(dbFor('admin'), 'invoices', 'history'))).data().paymentStatus, 'paid');
});

test('Admin assignment and reassignment change User visibility without changing customer ID or contact reservation', async () => {
  await save('admin', 'assigned', { ...input, assignedUserId: 'userA' });
  const key = await customerContactHash(input.contact);
  assert.equal((await getDocs(query(collection(dbFor('userA'), 'customers'), where('assignedUserId', '==', 'userA')))).size, 1);
  await assertSucceeds(getDoc(doc(dbFor('userA'), 'customers', 'assigned')));
  await assertFails(getDoc(doc(dbFor('userB'), 'customers', 'assigned')));
  await assertFails(getDocs(collection(dbFor('userA'), 'customers')));
  await assertFails(updateDoc(doc(dbFor('userA'), 'customers', 'assigned'), { assignedUserId: 'userB' }));
  await assertFails(save('account', 'account-assigned', { ...input, contact: '9999999999', assignedUserId: 'userB' }));
  await save('admin', 'assigned', { ...input, assignedUserId: 'userB' }, false);
  await assertFails(getDoc(doc(dbFor('userA'), 'customers', 'assigned')));
  await assertSucceeds(getDoc(doc(dbFor('userB'), 'customers', 'assigned')));
  assert.equal((await getDocs(query(collection(dbFor('userB'), 'customers'), where('assignedUserId', '==', 'userB')))).size, 1);
  assert.equal((await getDoc(doc(dbFor('admin'), 'customerContacts', key))).data().customerId, 'assigned');
  const customer = (await getDoc(doc(dbFor('admin'), 'customers', 'assigned'))).data();
  const audit = (await getDoc(doc(dbFor('admin'), 'auditLogs', customer.lastAuditId))).data();
  assert.equal(audit.detail.before.assignedUserId, 'userA');
  assert.equal(audit.detail.after.assignedUserId, 'userB');
});

test('legacy unassigned customer stays staff-only until Admin assigns an active User', async () => {
  await save('account', 'legacy');
  await assertFails(getDoc(doc(dbFor('userA'), 'customers', 'legacy')));
  await assertSucceeds(getDoc(doc(dbFor('admin'), 'customers', 'legacy')));
  await assertFails(save('admin', 'legacy', { ...input, assignedUserId: 'inactive' }, false));
  await save('admin', 'legacy', { ...input, assignedUserId: 'userA' }, false);
  await assertSucceeds(getDoc(doc(dbFor('userA'), 'customers', 'legacy')));
});

async function rawCreate(id, change = {}, auditChange = {}, options = {}) {
  const db = dbFor('admin'), key = await customerContactHash(input.contact), auditId = `audit-${id}`;
  const data = { ...input, assignedUserId: null, contactKey: key, ownerUserIds: [], orderLinks: {}, createdBy: 'admin', updatedBy: 'admin', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastAuditId: auditId, ...change };
  const after = Object.fromEntries(['fullName', 'contact', 'address', 'area', 'dateOfBirth', 'sabha', 'assignedUserId'].map((field) => [field, data[field]]));
  const batch = writeBatch(db);
  batch.set(doc(db, 'customers', id), data);
  if (!options.omitReservation) batch.set(doc(db, 'customerContacts', data.contactKey), { customerId: id, createdAt: serverTimestamp(), ...options.reservationChange });
  if (!options.omitAudit) batch.set(doc(db, 'auditLogs', auditId), { type: 'customer.created', actorUid: 'admin', referenceType: 'customer', referenceId: id, detail: { before: null, after }, at: serverTimestamp(), ...auditChange });
  options.extraWrites?.(batch, db);
  return batch.commit();
}

test('missing or mismatched dependencies and forged audit snapshots reject the entire creation', async () => {
  const attempts = [
    ['no-reservation', {}, { omitReservation: true }],
    ['no-audit', {}, { omitAudit: true }],
    ['wrong-reservation', {}, { reservationChange: { customerId: 'another-customer' } }],
    ['wrong-reference', { referenceId: 'another-customer' }, {}],
    ['wrong-before', { detail: { before: input, after: input } }, {}],
    ['wrong-after', { detail: { before: null, after: { ...input, fullName: 'Invented' } } }, {}],
    ['wrong-type', { type: 'customer.updated' }, {}],
  ];
  for (const [id, auditChange, options] of attempts) {
    await assertFails(rawCreate(id, {}, auditChange, options));
    assert.equal((await getDoc(doc(dbFor('admin'), 'customers', id))).exists(), false);
    assert.equal((await getDoc(doc(dbFor('admin'), 'auditLogs', `audit-${id}`))).exists(), false);
  }
  assert.equal((await getDoc(doc(dbFor('admin'), 'customerContacts', await customerContactHash(input.contact)))).exists(), false);
});

test('customer batches cannot smuggle operational, role or audit-history writes', async () => {
  for (const uid of ['admin', 'account']) await save(uid, `existing-${uid}`, { ...input, contact: uid === 'admin' ? '1111111111' : '2222222222' });
  const oldAudit = (await getDoc(doc(dbFor('admin'), 'customers', 'existing-admin'))).data().lastAuditId;
  const writes = [
    (batch, db) => batch.set(doc(db, 'orders', 'forged'), { ownerUid: 'admin', status: 'confirmed' }),
    (batch, db) => batch.set(doc(db, 'inventory', 'forged'), { onHandQty: 999999 }),
    (batch, db) => batch.set(doc(db, 'invoices', 'forged'), { paymentStatus: 'paid' }),
    (batch, db) => batch.set(doc(db, 'payments', 'forged'), { verificationStatus: 'verified' }),
    (batch, db) => batch.update(doc(db, 'users', 'admin'), { role: 'account_admin' }),
    (batch, db) => batch.update(doc(db, 'auditLogs', oldAudit), { type: 'invented' }),
    (batch, db) => batch.delete(doc(db, 'auditLogs', oldAudit)),
  ];
  for (const [index, extraWrites] of writes.entries()) {
    const id = `smuggled-${index}`;
    await assertFails(rawCreate(id, {}, {}, { extraWrites }));
    assert.equal((await getDoc(doc(dbFor('admin'), 'customers', id))).exists(), false);
    assert.equal((await getDoc(doc(dbFor('admin'), 'auditLogs', `audit-${id}`))).exists(), false);
  }
  assert.equal((await getDoc(doc(dbFor('admin'), 'users', 'admin'))).data().role, 'admin');
  assert.equal((await getDoc(doc(dbFor('admin'), 'auditLogs', oldAudit))).data().type, 'customer.created');
});

test('reservations cannot be stolen, deleted alone or left behind by a contact change', async () => {
  await save('admin', 'reserved');
  const db = dbFor('admin'), key = await customerContactHash(input.contact);
  await assertFails(updateDoc(doc(db, 'customerContacts', key), { customerId: 'thief' }));
  await assertFails(deleteDoc(doc(db, 'customerContacts', key)));
  await assertFails(rawCreate('thief'));
  const old = (await getDoc(doc(db, 'customers', 'reserved'))).data();
  const next = { ...input, contact: '5555555555' }, nextKey = await customerContactHash(next.contact);
  const batch = writeBatch(db);
  batch.update(doc(db, 'customers', 'reserved'), { ...next, contactKey: nextKey, updatedBy: 'admin', updatedAt: serverTimestamp(), lastAuditId: 'changed-contact' });
  batch.set(doc(db, 'customerContacts', nextKey), { customerId: 'reserved', createdAt: serverTimestamp() });
  batch.set(doc(db, 'auditLogs', 'changed-contact'), { type: 'customer.updated', actorUid: 'admin', referenceType: 'customer', referenceId: 'reserved', detail: { before: { ...input, assignedUserId: null }, after: { ...next, assignedUserId: null } }, at: serverTimestamp() });
  await assertFails(batch.commit());
  assert.equal((await getDoc(doc(db, 'customers', 'reserved'))).data().contactKey, old.contactKey);
  assert.equal((await getDoc(doc(db, 'customerContacts', nextKey))).exists(), false);
});

test('both staff roles can edit; edits cannot change creator, ownership or existing audit snapshots', async () => {
  await save('admin', 'editable-staff');
  for (const uid of ['admin', 'account']) await save(uid, 'editable-staff', { ...input, fullName: `Edited by ${uid}` }, false);
  const db = dbFor('admin'), current = (await getDoc(doc(db, 'customers', 'editable-staff'))).data();
  for (const change of [{ createdBy: 'account' }, { createdAt: serverTimestamp() }, { ownerUserIds: ['userA'] }, { orderLinks: { userA: 'forged' } }]) {
    const batch = writeBatch(db), auditId = 'tampered-edit';
    batch.update(doc(db, 'customers', 'editable-staff'), { ...change, updatedBy: 'admin', updatedAt: serverTimestamp(), lastAuditId: auditId });
    const before = { ...input, fullName: current.fullName, assignedUserId: null };
    batch.set(doc(db, 'auditLogs', auditId), { type: 'customer.updated', actorUid: 'admin', referenceType: 'customer', referenceId: 'editable-staff', detail: { before, after: before }, at: serverTimestamp() });
    await assertFails(batch.commit());
  }
  assert.equal((await getDoc(doc(db, 'customers', 'editable-staff'))).data().createdBy, 'admin');
  assert.equal((await getDocs(collection(db, 'auditLogs'))).size, 3);
  await assertFails(setDoc(doc(db, 'auditLogs', 'unpaired'), { type: 'customer.updated', actorUid: 'admin', referenceType: 'customer', referenceId: 'editable-staff', detail: { before: input, after: input }, at: serverTimestamp() }));
});

test('inactive, missing and malformed profiles cannot edit; User cannot list customers or access reservations', async () => {
  await save('admin', 'private');
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', 'invalid-role'), { role: 'Admin', active: true, fullName: 'Invalid' });
    await setDoc(doc(context.firestore(), 'users', 'missing-name'), { role: 'admin', active: true });
  });
  for (const uid of ['inactive', 'missing', 'userA', 'invalid-role', 'missing-name']) {
    await assertFails(save(uid, 'private', { ...input, fullName: 'Forbidden edit' }, false));
  }
  await assertFails(getDocs(collection(dbFor('userA'), 'customers')));
  await assertFails(getDoc(doc(dbFor('userA'), 'customerContacts', await customerContactHash(input.contact))));
});

test('direct requests reject ownership, author, contact-hash, date, field and audit tampering', async () => {
  await assertFails(rawCreate('owners', { ownerUserIds: ['userA'], orderLinks: { userA: 'someone-elses-order' } }));
  await assertFails(rawCreate('author', { createdBy: 'userA' }));
  await assertFails(rawCreate('hash', { contactKey: '0'.repeat(64) }));
  await assertFails(rawCreate('date', { dateOfBirth: '2026-02-30' }));
  await assertFails(rawCreate('field', { fullName: '' }));
  await assertFails(rawCreate('audit', {}, { actorUid: 'userA' }));
  await assertFails(setDoc(doc(dbFor('admin'), 'customers', 'no-dependencies'), input));
  await assertSucceeds(rawCreate('valid-birth', { dateOfBirth: '2024-02-29' }));
});

test('staff edit personal fields, release old reservations and preserve ownership and history', async () => {
  await save('admin', 'editable', { ...input, assignedUserId: 'userA' });
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'orders', 'own-order'), { ownerUid: 'userA', customerId: 'editable' });
    await updateDoc(doc(context.firestore(), 'customers', 'editable'), { ownerUserIds: ['userA'], orderLinks: { userA: 'own-order' } });
  });
  await save('account', 'editable', { ...input, contact: '9988112233', fullName: 'Updated customer' }, false);
  const data = (await getDoc(doc(dbFor('account'), 'customers', 'editable'))).data();
  assert.equal(data.createdBy, 'admin'); assert.deepEqual(data.ownerUserIds, ['userA']);
  await assertSucceeds(getDoc(doc(dbFor('userA'), 'customers', 'editable')));
  await assertFails(getDoc(doc(dbFor('userB'), 'customers', 'editable')));
  await assertFails(updateDoc(doc(dbFor('userA'), 'customers', 'editable'), { fullName: 'Unauthorized change' }));
  await assertFails(updateDoc(doc(dbFor('admin'), 'customers', 'editable'), { ownerUserIds: ['userB'] }));
  await assertFails(deleteDoc(doc(dbFor('admin'), 'customers', 'editable')));
  await assertFails(deleteDoc(doc(dbFor('admin'), 'auditLogs', data.lastAuditId)));
  assert.equal((await getDoc(doc(dbFor('admin'), 'customerContacts', await customerContactHash(input.contact)))).exists(), false);
  await assertFails(setDoc(doc(dbFor('admin'), 'auditLogs', 'fabricated'), { type: 'invoice.marked_paid', actorUid: 'admin', referenceType: 'invoice', referenceId: 'fake', at: serverTimestamp() }));
});

test('Firestore permission denial has a useful customer-form message', () => {
  assert.match(customerSaveError({ code: 'permission-denied' }), /updated customer Security Rules/);
  assert.match(customerSaveError({ code: 'unavailable' }), /same submission ID/);
});
