import { FieldValue } from 'firebase-admin/firestore';
import { audit, fail, money, text, validDate, validId } from './operations.js';

const periods = new Set(['daily', 'weekly', 'monthly']);
const trim = (value) => typeof value === 'string' ? value.trim() : '';

async function actor(db, tx, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return snap.data().role;
}

export function periodEnd(periodType, start) {
  if (!periods.has(periodType) || !validDate(start)) fail('Choose a valid target period and start date.');
  const date = new Date(`${start}T00:00:00Z`);
  if (periodType === 'weekly' && date.getUTCDay() !== 1) fail('Weekly targets must start on Monday.');
  if (periodType === 'monthly' && date.getUTCDate() !== 1) fail('Monthly targets must start on the first day of the month.');
  if (periodType === 'weekly') date.setUTCDate(date.getUTCDate() + 6);
  if (periodType === 'monthly') { date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0); }
  return date.toISOString().slice(0, 10);
}

export async function saveTarget(db, uid, input) {
  if (!validId(input?.ownerUid) || !money(input.targetPaise) || typeof input.active !== 'boolean') fail('Target user, nonnegative amount and status are required.');
  const end = periodEnd(input.periodType, input.periodStart);
  const targetId = `${input.ownerUid}_${input.periodType}_${input.periodStart}`;
  const ref = db.doc(`targets/${targetId}`);
  return db.runTransaction(async (tx) => {
    if (!['admin', 'account_admin'].includes(await actor(db, tx, uid))) fail('Active Admin or Account Admin access is required.');
    const owner = await tx.get(db.doc(`users/${input.ownerUid}`));
    const old = await tx.get(ref);
    if (!owner.exists || owner.data().role !== 'user') fail('Assign a target to an existing User profile.');
    const values = { ownerUid: input.ownerUid, periodType: input.periodType, periodStart: input.periodStart, periodEnd: end, targetPaise: input.targetPaise, active: input.active, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    audit(tx, db, old.exists ? 'target.updated' : 'target.created', uid, 'target', targetId, { previousTargetPaise: old.exists ? old.data().targetPaise : null, targetPaise: input.targetPaise, previousActive: old.exists ? old.data().active : null, active: input.active });
    return { targetId };
  });
}

export async function saveAnnouncement(db, uid, input) {
  if (!text(input?.title, 120) || !text(input.body, 1000) || !['all', 'staff', 'users'].includes(input.audience) || typeof input.active !== 'boolean' || !validDate(input.startsOn) || !validDate(input.expiresOn) || input.expiresOn < input.startsOn) fail('Announcement title, body, audience, dates and status are required.');
  const announcementId = input.announcementId || db.collection('announcements').doc().id;
  if (!validId(announcementId)) fail('Invalid announcement ID.');
  const ref = db.doc(`announcements/${announcementId}`);
  return db.runTransaction(async (tx) => {
    if (!['admin', 'account_admin'].includes(await actor(db, tx, uid))) fail('Active Admin or Account Admin access is required.');
    const old = await tx.get(ref);
    const values = { title: trim(input.title), titleKey: trim(input.title).toLocaleLowerCase(), body: trim(input.body), audience: input.audience, active: input.active, startsOn: input.startsOn, expiresOn: input.expiresOn, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    audit(tx, db, old.exists ? 'announcement.updated' : 'announcement.created', uid, 'announcement', announcementId, {
      before: old.exists ? { title: old.data().title, audience: old.data().audience, active: old.data().active, startsOn: old.data().startsOn, expiresOn: old.data().expiresOn } : null,
      after: { title: values.title, audience: values.audience, active: values.active, startsOn: values.startsOn, expiresOn: values.expiresOn },
    });
    return { announcementId };
  });
}

export async function saveUserProfile(db, uid, input) {
  if (!validId(input?.targetUid) || !text(input.displayName, 80) || !['admin', 'account_admin', 'user'].includes(input.role) || typeof input.active !== 'boolean') fail('Existing Auth UID, name, role and status are required.');
  if (input.targetUid === uid) fail('You cannot change your own profile.');
  const ref = db.doc(`users/${input.targetUid}`);
  return db.runTransaction(async (tx) => {
    const actorRole = await actor(db, tx, uid);
    const old = await tx.get(ref);
    if (!['admin', 'account_admin'].includes(actorRole) || actorRole !== 'admin' && (input.role !== 'user' || old?.data()?.role && old.data().role !== 'user')) fail('Only an Admin can manage staff roles.');
    const values = { displayName: trim(input.displayName), role: input.role, active: input.active, updatedAt: FieldValue.serverTimestamp() };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdAt: FieldValue.serverTimestamp() });
    audit(tx, db, old.exists ? 'user.updated' : 'user.created', uid, 'user', input.targetUid, {
      before: old.exists ? { displayName: old.data().displayName || old.data().fullName || '', role: old.data().role, active: old.data().active } : null,
      after: { displayName: values.displayName, role: values.role, active: values.active },
    });
    return { targetUid: input.targetUid };
  });
}
