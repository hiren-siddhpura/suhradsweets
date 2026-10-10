import { collection, doc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { customerContactHash, validateCustomerInput } from './customer-validation.js';

const snapshotFields = (data) => Object.fromEntries(['fullName', 'contact', 'address', 'area', 'dateOfBirth', 'sabha'].map((key) => [key, data[key] ?? null]));
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.includes('/') && !['.', '..'].includes(id);

export async function saveCustomerDirect(db, auth, input, { customerId, create = true }) {
  const uid = auth?.currentUser?.uid;
  if (!uid) throw Object.assign(new Error('Sign in before saving a customer.'), { code: 'unauthenticated' });
  if (!validId(customerId)) throw new Error('Invalid customer submission ID. Reopen the form.');
  const values = validateCustomerInput(input);
  const contactKey = await customerContactHash(values.contact);
  const customerRef = doc(db, 'customers', customerId);
  const reservationRef = doc(db, 'customerContacts', contactKey);
  const auditRef = doc(collection(db, 'auditLogs'));
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(customerRef);
    if (create && existing.exists()) {
      const saved = existing.data();
      if (saved.createdBy === uid && Object.entries(values).every(([key, value]) => (saved[key] ?? null) === value)) return { customerId, alreadySaved: true };
      throw new Error('This submission was already saved with different details. Refresh before editing.');
    }
    if (!create && !existing.exists()) throw new Error('Customer no longer exists. Refresh the list.');
    const reservation = await transaction.get(reservationRef);
    const old = existing.exists() ? existing.data() : null;
    const oldKey = old ? old.contactKey || await customerContactHash(old.contact) : null;
    const oldRef = oldKey && oldKey !== contactKey ? doc(db, 'customerContacts', oldKey) : null;
    const oldReservation = oldRef ? await transaction.get(oldRef) : null;
    if (reservation.exists() && reservation.data().customerId !== customerId) throw new Error('A customer with this contact already exists. Search before adding a duplicate.');
    if (oldReservation?.exists() && oldReservation.data().customerId !== customerId) throw new Error('The existing contact reservation needs administrative review.');
    if (oldReservation?.exists()) transaction.delete(oldRef);
    if (!reservation.exists()) transaction.set(reservationRef, { customerId, createdAt: serverTimestamp() });
    const changes = { ...values, contactKey, updatedBy: uid, updatedAt: serverTimestamp(), lastAuditId: auditRef.id };
    if (old) transaction.update(customerRef, changes);
    else transaction.set(customerRef, { ...changes, ownerUserIds: [], orderLinks: {}, createdBy: uid, createdAt: serverTimestamp() });
    transaction.set(auditRef, {
      type: old ? 'customer.updated' : 'customer.created', actorUid: uid, referenceType: 'customer', referenceId: customerId,
      detail: { before: old ? snapshotFields(old) : null, after: snapshotFields(values) }, at: serverTimestamp(),
    });
    return { customerId, alreadySaved: false };
  });
}
