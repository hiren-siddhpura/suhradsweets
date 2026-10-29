import { addDoc, collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, updateDoc, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { DASHBOARD_TARGET_ID, DASHBOARD_TARGET_KEY, validateTargetKg } from './dashboard-metrics.js';
import { hasDuplicateItemName, MASTER_TYPES, validateMasterInput } from './master-validation.js';
import { callOperation } from './operations-data.js';
import { BUSINESS_DETAILS_ID, validateBusinessDetails } from './business-settings.js';
import { uniqueId } from './unique-id.js';
import { isStaff } from './permissions.js';

function assertType(type) {
  if (!MASTER_TYPES.includes(type)) throw new Error('Unknown master-data collection.');
}

export async function readDashboardTarget(db) {
  const snapshot = await getDoc(doc(db, 'settings', DASHBOARD_TARGET_ID));
  return snapshot.exists() && snapshot.data().active ? snapshot.data().value : '';
}

export async function saveDashboardTarget(db, input, actor) {
  if (!actor?.uid || !isStaff(actor.profile || { role: actor.role, active: true })) throw new Error('Access denied: staff access is required.');
  const value = validateTargetKg(input);
  const ref = doc(db, 'settings', DASHBOARD_TARGET_ID);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const values = { key: DASHBOARD_TARGET_KEY, value, description: 'Dashboard confirmed sales target in KG for the selected reporting period.', active: true, updatedAt: serverTimestamp() };
    if (snapshot.exists()) transaction.update(ref, values);
    else transaction.set(ref, { ...values, createdAt: serverTimestamp() });
  });
}

export async function readBusinessDetails(db) {
  const snapshot = await getDoc(doc(db, 'settings', BUSINESS_DETAILS_ID));
  return snapshot.exists() ? validateBusinessDetails(snapshot.data()) : validateBusinessDetails();
}

export async function saveBusinessDetails(db, input, actor) {
  if (!actor?.uid || actor.role !== 'admin') throw new Error('Access denied: only Admin may change business details.');
  const values = validateBusinessDetails(input);
  const ref = doc(db, 'settings', BUSINESS_DETAILS_ID);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists()) transaction.update(ref, { ...values, updatedAt: serverTimestamp() });
    else transaction.set(ref, { key: 'businessDetails', ...values, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
  return values;
}

export async function listMasterRecords(db, type) {
  assertType(type);
  const snapshot = await getDocs(collection(db, type));
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
}

async function requireActiveUnit(db, unitId) {
  const snapshot = await getDoc(doc(db, 'units', unitId));
  if (!snapshot.exists() || snapshot.data().active !== true) throw new Error('Choose an active unit.');
}

export async function saveMasterRecord(db, type, id, input, actor, functions = null) {
  assertType(type);
  if (!actor?.uid || !isStaff(actor.profile || { role: actor.role, active: true })) throw new Error('Access denied: staff access is required.');
  if (type === 'users' && !['admin', 'account_admin'].includes(actor.role)) throw new Error('Access denied: only Admin or Account Admin may manage users.');
  if (id === actor.uid && type === 'users') throw new Error('You cannot change your own profile.');
  if (type === 'settings' && (id === DASHBOARD_TARGET_ID || input.key === DASHBOARD_TARGET_KEY)) {
    await saveDashboardTarget(db, input.value, actor);
    return DASHBOARD_TARGET_ID;
  }
  const reference = id ? doc(db, type, id) : null;
  const existingSnapshot = reference ? await getDoc(reference) : null;
  if (reference && !existingSnapshot.exists()) throw new Error('This record no longer exists. Refresh the list.');
  const existing = existingSnapshot?.data() || null;
  const values = validateMasterInput(type, input, { existing, actorRole: actor.role });
  if (type === 'items' && values.name.trim().toLocaleLowerCase() === 'gift packing') values.defaultUnitId = existing?.defaultUnitId || 'pcs';

  if (type === 'items') {
    const sameUnit = await getDocs(query(collection(db, 'items'), where('defaultUnitId', '==', values.defaultUnitId)));
    const items = sameUnit.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
    if (hasDuplicateItemName(items, values, id)) throw new Error('An item with this name and stock unit already exists.');
  }

  if (type === 'users') {
    if (!functions) throw new Error('Trusted user management is unavailable.');
    const result = await callOperation(functions, 'saveUserProfile', { ...(id ? { targetUid: id } : {}), ...values, operationId: input.operationId });
    return result.targetUid;
  }

  if (type === 'items' && !id) {
    if (values.defaultUnitId === 'pcs') {
      const pcsRef = doc(db, 'units', 'pcs');
      await runTransaction(db, async (transaction) => {
        const unit = await transaction.get(pcsRef);
        if (!unit.exists()) transaction.set(pcsRef, { name: 'Pieces', symbol: 'PCS', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        else if (unit.data().active !== true || unit.data().symbol !== 'PCS') throw new Error('The PCS stock unit must be active with symbol PCS.');
      });
    }
    if (values.defaultUnitId === 'kg') {
      const defaultUnitRef = doc(db, 'units', 'kg');
      await runTransaction(db, async (transaction) => {
        const unit = await transaction.get(defaultUnitRef);
        if (!unit.exists()) transaction.set(defaultUnitRef, { name: 'Kilogram', symbol: 'kg', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        else if (unit.data().active !== true) throw new Error('The KG stock unit is inactive. Ask an administrator to reactivate it.');
      });
    }
    const itemRef = doc(collection(db, 'items'));
    const codeRef = doc(db, 'itemCodes', values.itemCode);
    const unitRef = doc(db, 'units', values.defaultUnitId);
    await runTransaction(db, async (transaction) => {
      const codeSnapshot = await transaction.get(codeRef);
      const unitSnapshot = await transaction.get(unitRef);
      if (codeSnapshot.exists()) throw new Error('This item code is already in use.');
      if (!unitSnapshot.exists() || unitSnapshot.data().active !== true) throw new Error('Choose an active unit.');
      transaction.set(itemRef, { ...values, createdBy: actor.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      transaction.set(codeRef, { itemId: itemRef.id, createdAt: serverTimestamp() });
    });
    return itemRef.id;
  }
  if (type === 'items' && values.defaultUnitId === 'pcs') {
    const unit = await getDoc(doc(db, 'units', 'pcs'));
    if (!unit.exists() || unit.data().active !== true || unit.data().symbol !== 'PCS') throw new Error('The PCS stock unit must be active with symbol PCS.');
  }
  if (type === 'items' && (!existing || values.defaultUnitId !== existing.defaultUnitId)) await requireActiveUnit(db, values.defaultUnitId);
  if (reference) {
    await updateDoc(reference, { ...values, updatedAt: serverTimestamp() });
    return id;
  }
  const created = await addDoc(collection(db, type), { ...values, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return created.id;
}

export async function deactivateMasterRecord(db, type, id, actor, functions = null, operationId = null) {
  assertType(type);
  if (!actor?.uid || !isStaff(actor.profile || { role: actor.role, active: true })) throw new Error('Access denied: staff access is required.');
  if (type === 'users' && !['admin', 'account_admin'].includes(actor.role)) throw new Error('Access denied: only Admin or Account Admin may manage users.');
  if (type === 'users' && id === actor.uid) throw new Error('You cannot deactivate your own profile.');
  const reference = doc(db, type, id);
  const snapshot = await getDoc(reference);
  if (!snapshot.exists()) throw new Error('This record no longer exists. Refresh the list.');
  if (type === 'users') {
    if (!functions) throw new Error('Trusted user management is unavailable.');
    await callOperation(functions, 'saveUserProfile', { targetUid: id, displayName: snapshot.data().displayName || snapshot.data().fullName, email: snapshot.data().email, role: snapshot.data().role, active: false, operationId: operationId || uniqueId() });
    return;
  }
  await updateDoc(reference, { active: false, updatedAt: serverTimestamp() });
}
