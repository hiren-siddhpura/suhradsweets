import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { manageUser } from '../functions/user-operations.js';
import { randomUUID } from 'node:crypto';
import { initializeApp as clientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { getAuth as clientAuth, connectAuthEmulator, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Both emulators are required.');
const app = initializeApp({ projectId: 'demo-user-provisioning-tests' }, 'user-provisioning');
const db = getFirestore(app), auth = getAuth(app);
const values = { fullName: 'New User', email: 'new-user@example.test', role: 'user', active: true, operationId: 'create-one' };
const save = (input = values, uid = 'admin', database = db, service = auth) => manageUser(database, uid, input, service);
test.beforeEach(async () => {
  for (const collection of await db.listCollections()) for (const document of (await collection.get()).docs) await document.ref.delete();
  for (const user of (await auth.listUsers()).users) await auth.deleteUser(user.uid);
  for (const [uid, role, active] of [['admin', 'admin', true], ['account', 'account_admin', true], ['user', 'user', true], ['inactive', 'admin', false]]) {
    await auth.createUser({ uid, email: `${uid}@example.test` });
    await db.doc(`users/${uid}`).set({ fullName: uid, role, active });
  }
});
test.after(() => deleteApp(app));
test('creation obtains the UID, writes a matching profile and retries without duplicates', async () => {
  const first = await save(), second = await save();
  assert.equal(first.targetUid, second.targetUid); assert.equal(second.repeated, true);
  assert.equal((await auth.getUser(first.targetUid)).disabled, false);
  const profile = (await db.doc(`users/${first.targetUid}`).get()).data();
  assert.equal(profile.fullName, values.fullName); assert.equal(profile.email, values.email); assert.equal(profile.role, 'user');
  assert.ok(profile.createdAt); assert.ok(profile.updatedAt); assert.equal(profile.password, undefined);
  assert.equal((await db.collection('users').get()).size, 6);
  assert.equal((await db.collection('auditLogs').where('type', '==', 'user.created').get()).size, 1);
});
test('Admin manages users and roles; Account Admin is limited to User profiles', async () => {
  for (const uid of ['', 'missing', 'inactive', 'user']) await assert.rejects(save(values, uid));
  await assert.rejects(save({ ...values, role: 'admin' }, 'account'), /Access denied/);
  await assert.rejects(save({ ...values, role: 'owner' }), /required/);
  await assert.rejects(save({ ...values, targetUid: 'admin' }), /own profile/);
  const staff = await save({ ...values, role: 'account_admin' });
  await assert.rejects(save({ ...values, targetUid: staff.targetUid, role: 'user', operationId: 'demote' }, 'account'), /Access denied/);
  await assert.rejects(save({ ...values, email: 'account-created@example.test', operationId: 'account-create' }, 'account'), /Access denied/);
});
test('duplicate email never attaches an existing account or creates another profile', async () => {
  const first = await save();
  await assert.rejects(save({ ...values, operationId: 'duplicate' }), /already uses this email/);
  assert.equal((await db.collection('users').get()).size, 5);
  assert.equal((await auth.getUser(first.targetUid)).disabled, false);
  await assert.rejects(save({ ...values, fullName: 'Changed' }), /different details/);
});
test('profile-stage failure leaves a disabled account and resumes the same UID', async () => {
  let calls = 0;
  const failingDb = new Proxy(db, { get(target, name) {
    if (name === 'runTransaction') return (...args) => { if (++calls === 3) throw new Error('Injected profile failure'); return target.runTransaction(...args); };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  await assert.rejects(save(values, 'admin', failingDb), /incomplete/);
  const job = (await db.doc('userOperations/create-one').get()).data();
  assert.equal(job.status, 'failed'); assert.equal((await auth.getUser(job.targetUid)).disabled, true);
  assert.equal((await db.doc(`users/${job.targetUid}`).get()).exists, false);
  const resumed = await save(); assert.equal(resumed.targetUid, job.targetUid);
  assert.equal((await auth.listUsers()).users.length, 5);
});
test('Auth failure cannot leave an active profile; retry preserves the existing UID', async () => {
  const created = await save();
  const update = { ...values, targetUid: created.targetUid, operationId: 'edit', email: 'updated@example.test', fullName: 'Updated' };
  const failingAuth = new Proxy(auth, { get(target, name) {
    if (name === 'updateUser') return async () => { throw new Error('Injected Auth failure'); };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  await assert.rejects(save(update, 'admin', db, failingAuth), /incomplete/);
  assert.equal((await db.doc(`users/${created.targetUid}`).get()).data().active, false);
  assert.equal((await save(update)).targetUid, created.targetUid);
  assert.equal((await auth.getUser(created.targetUid)).email, update.email);
  assert.equal((await db.collection('users').get()).size, 5);
});
test('deactivation preserves all history and disables Authentication', async () => {
  const created = await save();
  for (const name of ['orders', 'invoices', 'payments']) await db.doc(`${name}/historical`).set({ ownerUid: created.targetUid });
  await save({ ...values, targetUid: created.targetUid, operationId: 'deactivate', active: false });
  assert.equal((await auth.getUser(created.targetUid)).disabled, true);
  assert.equal((await db.doc(`users/${created.targetUid}`).get()).data().active, false);
  for (const name of ['orders', 'invoices', 'payments']) assert.equal((await db.doc(`${name}/historical`).get()).exists, true);
  assert.equal((await db.collection('auditLogs').where('type', '==', 'user.created').get()).size, 1);
});
test('concurrent duplicate submissions serialize and never create two accounts', async () => {
  const results = await Promise.allSettled([save(), save()]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal((await auth.listUsers()).users.length, 5);
  assert.equal((await db.collection('users').get()).size, 5);
});
test('account creation and password setup leave the current Admin session intact', async () => {
  const password = randomUUID();
  await auth.updateUser('admin', { password });
  const client = clientApp({ apiKey: 'demo-key', projectId: 'demo-user-provisioning-tests', appId: 'demo-users' }, 'user-session-test');
  const session = clientAuth(client);
  connectAuthEmulator(session, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  try {
    await signInWithEmailAndPassword(session, 'admin@example.test', password);
    await save();
    await sendPasswordResetEmail(session, values.email);
    assert.equal(session.currentUser.uid, 'admin');
  } finally { await signOut(session); await deleteClientApp(client); }
});
test('finalization failure keeps a staged profile inactive and retries complete safely', async () => {
  let calls = 0;
  const failingDb = new Proxy(db, { get(target, name) {
    if (name === 'runTransaction') return (...args) => { if (++calls === 4) throw new Error('Injected finalization failure'); return target.runTransaction(...args); };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  await assert.rejects(save(values, 'admin', failingDb), /incomplete/);
  const job = (await db.doc('userOperations/create-one').get()).data();
  assert.equal((await db.doc(`users/${job.targetUid}`).get()).data().active, false);
  assert.equal((await auth.getUser(job.targetUid)).disabled, true);
  await save();
  assert.equal((await db.doc(`users/${job.targetUid}`).get()).data().active, true);
});
test('real callable rejects anonymous requests and preserves the Admin session', { skip: !process.env.OMS_USER_FUNCTIONS_PORT }, async () => {
  const client = clientApp({ apiKey: 'demo-key', projectId: 'demo-user-provisioning-tests', appId: 'demo-callable-users' }, 'user-callable-test');
  const session = clientAuth(client);
  connectAuthEmulator(session, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const functions = getFunctions(client, 'us-central1');
  connectFunctionsEmulator(functions, '127.0.0.1', Number(process.env.OMS_USER_FUNCTIONS_PORT));
  try {
    await assert.rejects(httpsCallable(functions, 'saveUserProfileCall')(values), /Sign in/);
    const password = randomUUID(); await auth.updateUser('admin', { password });
    await signInWithEmailAndPassword(session, 'admin@example.test', password);
    const result = (await httpsCallable(functions, 'saveUserProfileCall')(values)).data;
    assert.equal((await db.doc(`users/${result.targetUid}`).get()).data().email, values.email);
    assert.equal(session.currentUser.uid, 'admin');
  } finally { await signOut(session); await deleteClientApp(client); }
});
