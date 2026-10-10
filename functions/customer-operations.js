import { createHash } from 'node:crypto';
import { audit, fail, validId } from './operations.js';

export const CUSTOMER_LINKED_MESSAGE = 'Cannot delete this customer because transaction records are linked to them.';
// Extend this registry before introducing any new customer-bearing business collection.
const businessCollections = ['orders', 'invoices', 'payments', 'paymentReversals', 'purchases', 'inventoryMovements'];

export async function deleteCustomer(db, uid, input) {
  if (!validId(uid) || !validId(input?.customerId)) fail('Sign in and select a valid customer.');
  const customerRef = db.doc(`customers/${input.customerId}`);
  return db.runTransaction(async (tx) => {
    const actor = await tx.get(db.doc(`users/${uid}`));
    if (!actor.exists || actor.data().active !== true || !['admin', 'account_admin'].includes(actor.data().role)) fail('Active Admin or Account Admin access is required.');
    const customer = await tx.get(customerRef);
    if (!customer.exists) fail('Customer no longer exists. Refresh the list.');
    const data = customer.data();
    if ((data.ownerUserIds || []).length || Object.keys(data.orderLinks || {}).length) fail(CUSTOMER_LINKED_MESSAGE);
    // No status filter: drafts and cancelled records permanently prevent deletion.
    for (const name of businessCollections) {
      for (const field of ['customerId', 'customerSnapshot.customerId']) {
        if (!(await tx.get(db.collection(name).where(field, '==', customer.id).limit(1))).empty) fail(CUSTOMER_LINKED_MESSAGE);
      }
      // Legacy payments omit customerId. Conservatively block historical snapshots.
      if (typeof data.contact === 'string' && !(await tx.get(db.collection(name).where('customerSnapshot.contact', '==', data.contact).limit(1))).empty) fail(CUSTOMER_LINKED_MESSAGE);
    }
    const computedKey = createHash('sha256').update(String(data.contact || '').trim().toLowerCase().replace(/[\s()-]/g, '')).digest('hex');
    if (data.contactKey && data.contactKey !== computedKey) fail('Customer contact reservation needs administrative review.');
    const reservationRef = db.doc(`customerContacts/${data.contactKey || computedKey}`);
    const reservation = await tx.get(reservationRef);
    if (reservation.exists && reservation.data().customerId !== customer.id) fail('Customer contact reservation needs administrative review.');
    if (reservation.exists) tx.delete(reservationRef);
    tx.delete(customerRef);
    audit(tx, db, 'customer.deleted', uid, 'customer', customer.id, { before: data, after: null, reservationReleased: reservation.exists });
    return { customerId: customer.id, deleted: true };
  });
}
