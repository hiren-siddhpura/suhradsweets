import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { periodEnd, saveAnnouncement, saveTarget, saveUserProfile } from '../functions/reporting-operations.js';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run against demo Firestore emulator.');
const app = initializeApp({ projectId: 'demo-suh-oms' }, 'reporting-test');
const db = getFirestore(app);

test.beforeEach(async () => {
  for (const name of ['users', 'targets', 'announcements', 'auditLogs']) {
    const docs = await db.collection(name).get(); if (!docs.empty) { const batch = db.batch(); docs.forEach((entry) => batch.delete(entry.ref)); await batch.commit(); }
  }
  await Promise.all([
    db.doc('users/adminA').set({ displayName: 'Admin', role: 'admin', active: true }),
    db.doc('users/opsAdmin').set({ displayName: 'Operations Admin', role: 'admin', active: true }),
    db.doc('users/accountA').set({ displayName: 'Accounts', role: 'account_admin', active: true }),
    db.doc('users/userA').set({ displayName: 'User A', role: 'user', active: true }),
    db.doc('users/userB').set({ displayName: 'User B', role: 'user', active: true }),
  ]);
});
test.after(async () => deleteApp(app));

test('period boundaries and zero targets are stored exactly', async () => {
  assert.equal(periodEnd('daily', '2026-10-10'), '2026-10-10');
  assert.equal(periodEnd('weekly', '2026-10-05'), '2026-10-11');
  assert.equal(periodEnd('monthly', '2026-10-01'), '2026-10-31');
  assert.throws(() => periodEnd('weekly', '2026-10-10'), /Monday/);
  const { targetId } = await saveTarget(db, 'adminA', { ownerUid: 'userA', periodType: 'daily', periodStart: '2026-10-10', targetPaise: 0, active: true });
  const target = (await db.doc(`targets/${targetId}`).get()).data();
  assert.equal(target.targetPaise, 0); assert.equal(target.periodEnd, '2026-10-10');
  assert.equal((await db.collection('auditLogs').where('type', '==', 'target.created').get()).size, 1);
});

test('target edits are stable, audited, and reject unauthorized or invalid input', async () => {
  const input = { ownerUid: 'userA', periodType: 'weekly', periodStart: '2026-10-05', targetPaise: 50000, active: true };
  const { targetId } = await saveTarget(db, 'accountA', input);
  await saveTarget(db, 'adminA', { ...input, targetPaise: 75000, active: false });
  assert.equal((await db.collection('targets').get()).size, 1);
  assert.equal((await db.doc(`targets/${targetId}`).get()).data().active, false);
  const edit = (await db.collection('auditLogs').where('type', '==', 'target.updated').get()).docs[0].data();
  assert.equal(edit.detail.previousTargetPaise, 50000); assert.equal(edit.detail.targetPaise, 75000);
  await assert.rejects(saveTarget(db, 'userA', input), /Access denied/);
  await assert.rejects(saveTarget(db, 'opsAdmin', input), /Access denied/);
  await assert.rejects(saveTarget(db, 'adminA', { ...input, ownerUid: 'adminA' }), /User profile/);
  await assert.rejects(saveTarget(db, 'adminA', { ...input, targetPaise: -1 }), /nonnegative/);
});

test('announcements have explicit audience and expiry with audited activation', async () => {
  const input = { title: 'Holiday', body: 'Orders close early.', audience: 'all', startsOn: '2026-10-10', expiresOn: '2026-10-11', active: true };
  const { announcementId } = await saveAnnouncement(db, 'adminA', input);
  await saveAnnouncement(db, 'accountA', { ...input, announcementId, active: false });
  const announcement = (await db.doc(`announcements/${announcementId}`).get()).data();
  assert.equal(announcement.active, false); assert.equal(announcement.titleKey, 'holiday');
  assert.equal((await db.collection('auditLogs').where('type', '==', 'announcement.updated').get()).size, 1);
  await assert.rejects(saveAnnouncement(db, 'userA', input), /Access denied/);
  await assert.rejects(saveAnnouncement(db, 'opsAdmin', input), /Access denied/);
  await assert.rejects(saveAnnouncement(db, 'adminA', { ...input, expiresOn: '2026-10-09' }), /dates/);
});

test('profile changes require staff, protect self and staff roles, and record before/after', async () => {
  await assert.rejects(saveUserProfile(db, 'userA', { targetUid: 'userB', displayName: 'B', role: 'user', active: true }), /Access denied/);
  await assert.rejects(saveUserProfile(db, 'adminA', { targetUid: 'adminA', displayName: 'A', role: 'admin', active: true }), /own profile/);
  await assert.rejects(saveUserProfile(db, 'accountA', { targetUid: 'userB', displayName: 'B', role: 'admin', active: true }), /Access denied/);
  await assert.rejects(saveUserProfile(db, 'opsAdmin', { targetUid: 'userB', displayName: 'B', role: 'owner', active: true }), /valid role/);
  await saveUserProfile(db, 'adminA', { targetUid: 'userB', displayName: 'New B', role: 'user', active: false });
  const profile = (await db.doc('users/userB').get()).data();
  assert.equal(profile.active, false); assert.equal(profile.displayName, 'New B');
  const log = (await db.collection('auditLogs').where('type', '==', 'user.updated').get()).docs[0].data();
  assert.equal(log.actorUid, 'adminA'); assert.equal(log.detail.before.active, true); assert.equal(log.detail.after.active, false);
});
