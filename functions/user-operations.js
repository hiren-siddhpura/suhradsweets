import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { audit, fail, text, validId } from './operations.js';

async function authorize(tx, db, uid, targetUid, role, old) {
  const actor = await tx.get(db.doc(`users/${uid}`));
  if (!actor.exists || actor.data().active !== true || !['admin', 'account_admin'].includes(actor.data().role)) fail('Active Admin or Account Admin access is required.');
  if (targetUid === uid) fail('You cannot change your own profile.');
  if (actor.data().role !== 'admin' && (role !== 'user' || old?.role && old.role !== 'user')) fail('Only an Admin can manage staff roles.');
}

// Auth and Firestore cannot commit together. Keep the profile inactive until both
// sides are synchronized; failed requests resume under a durable operation lock.
export async function manageUser(db, uid, input, auth = getAuth()) {
  if (!validId(uid) || !validId(input?.operationId)) fail('A valid user operation ID is required.');
  const fullName = String(input.fullName || input.displayName || '').trim();
  if (!text(fullName, 80) || !['admin', 'account_admin', 'user'].includes(input.role) || typeof input.active !== 'boolean') fail('Full name, role and active status are required.');
  if (input.targetUid && !validId(input.targetUid)) fail('Invalid user ID.');
  // Check authorization before making privileged Auth lookups.
  await db.runTransaction(async tx => {
    const old = input.targetUid ? await tx.get(db.doc(`users/${input.targetUid}`)) : null;
    await authorize(tx, db, uid, input.targetUid, input.role, old?.data());
    if (input.targetUid && !old.exists) fail('User profile no longer exists. Refresh the list.');
  });
  const existingAuth = input.targetUid ? await auth.getUser(input.targetUid) : null;
  const email = String(input.email ?? existingAuth?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('Enter a valid email address.');
  const desired = { fullName, email, role: input.role, active: input.active };
  const opRef = db.doc(`userOperations/${input.operationId}`);
  const candidateUid = input.targetUid || randomUUID();
  const operation = await db.runTransaction(async tx => {
    const prior = await tx.get(opRef);
    const targetUid = prior.exists ? prior.data().targetUid : candidateUid;
    const ref = db.doc(`users/${targetUid}`), old = await tx.get(ref);
    const lockRef = db.doc(`userOperationLocks/${targetUid}`), lock = await tx.get(lockRef);
    await authorize(tx, db, uid, targetUid, desired.role, old.data());
    if (prior.exists) {
      const job = prior.data();
      if (job.actorUid !== uid || Object.entries(desired).some(([key, value]) => job.desired[key] !== value) || job.create !== !input.targetUid || (input.targetUid && job.targetUid !== input.targetUid)) fail('Operation ID was already used for different details. Reopen the form.');
      if (job.status === 'completed') return { ...job, completed: true };
      if (job.status !== 'failed') fail('This user operation is already running. Retry later or request administrative recovery.');
    } else if (input.targetUid && !old.exists) fail('User profile no longer exists. Refresh the list.');
    if (lock.exists && lock.data().operationId !== input.operationId) fail('Another user operation needs completion before editing this account.');
    const job = { targetUid, actorUid: uid, desired, create: !input.targetUid, before: prior.exists ? prior.data().before : old.exists ? old.data() : null, status: 'running', updatedAt: FieldValue.serverTimestamp() };
    tx.set(opRef, job);
    tx.set(lockRef, { operationId: input.operationId });
    if (old.exists) tx.update(ref, { active: false, updatedAt: FieldValue.serverTimestamp() });
    audit(tx, db, 'user.operation_started', uid, 'user', targetUid, { operationId: input.operationId, before: job.before, requested: desired });
    return job;
  });
  if (operation.completed) return { targetUid: operation.targetUid, repeated: true };
  const ref = db.doc(`users/${operation.targetUid}`);
  try {
    if (operation.create) {
      try { await auth.createUser({ uid: operation.targetUid, email, displayName: fullName, disabled: true }); }
      catch (error) {
        if (error.code !== 'auth/uid-already-exists') throw error;
        const account = await auth.getUser(operation.targetUid);
        if (account.email?.toLowerCase() !== email) fail('Provisioning account mismatch requires administrative review.');
      }
    }
    await auth.updateUser(operation.targetUid, { disabled: true });
    await auth.revokeRefreshTokens(operation.targetUid);
    await auth.updateUser(operation.targetUid, { email, displayName: fullName, ...(existingAuth && existingAuth.email?.toLowerCase() !== email ? { emailVerified: false } : {}) });
    await db.runTransaction(async tx => {
      const old = await tx.get(ref);
      await authorize(tx, db, uid, operation.targetUid, desired.role, operation.before);
      tx.set(ref, { ...desired, displayName: fullName, active: false, updatedAt: FieldValue.serverTimestamp(), ...(old.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
    });
    if (desired.active) await auth.updateUser(operation.targetUid, { disabled: false });
    await db.runTransaction(async tx => {
      await authorize(tx, db, uid, operation.targetUid, desired.role, operation.before);
      tx.update(ref, { active: desired.active, updatedAt: FieldValue.serverTimestamp() });
      tx.update(opRef, { status: 'completed', updatedAt: FieldValue.serverTimestamp() });
      tx.delete(db.doc(`userOperationLocks/${operation.targetUid}`));
      audit(tx, db, operation.create ? 'user.created' : 'user.updated', uid, 'user', operation.targetUid, { operationId: input.operationId, before: operation.before, after: desired });
    });
    return { targetUid: operation.targetUid };
  } catch (error) {
    // Never delete an Auth account as compensation. A profile remains inactive.
    await auth.updateUser(operation.targetUid, { disabled: true }).catch(() => {});
    await opRef.update({ status: 'failed', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    if (error.code === 'auth/email-already-exists') fail('An Authentication account already uses this email. No account was attached or overwritten.');
    if (error.code === 'auth/user-not-found') fail('The matching Authentication account is missing. Administrative review is required.');
    fail(error.message?.includes('access is required') || error.message?.includes('staff roles') ? error.message : 'User setup is incomplete. Access remains blocked. Retry with the same details; administrative recovery may be required.');
  }
}
