import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { deleteCustomer, CUSTOMER_LINKED_MESSAGE } from '../functions/customer-operations.js';
import { saveOrderDraft } from '../functions/order-operations.js';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
const app = initializeApp({ projectId: 'demo-customer-deletion-tests' }, 'customer-deletion');
const db = getFirestore(app), contactKey = createHash('sha256').update('9876543210').digest('hex');
const customer = { fullName: 'Unused customer', contact: '9876543210', address: 'Street', area: 'West', sabha: false, ownerUserIds: [], orderLinks: {}, contactKey };
const remove = (uid = 'super') => deleteCustomer(db, uid, { customerId: 'customer' });
test.beforeEach(async () => {
  for (const collection of await db.listCollections()) {
    const docs = await collection.get();
    for (const doc of docs.docs) await doc.ref.delete();
  }
  await Promise.all([
    db.doc('users/admin').set({ role: 'admin', active: true, fullName: 'Admin' }),
    db.doc('users/admin').set({ role: 'admin', active: true, fullName: 'Admin' }),
    db.doc('users/account').set({ role: 'account_admin', active: true }),
    db.doc('users/user').set({ role: 'user', active: true }),
    db.doc('users/inactive').set({ role: 'admin', active: false }),
    db.doc('customers/customer').set(customer),
    db.doc(`customerContacts/${contactKey}`).set({ customerId: 'customer' }),
    db.doc('auditLogs/historical').set({ type: 'customer.created', actorUid: 'admin' }),
  ]);
});
test.after(() => deleteApp(app));
test('privileged roles can delete unused customers with reservation release and immutable history', async () => {
  for (const uid of ['super', 'account']) {
    if (uid === 'account') {
      await db.doc('customers/customer').set(customer);
      await db.doc(`customerContacts/${contactKey}`).set({ customerId: 'customer' });
    }
    await remove(uid);
    assert.equal((await db.doc('customers/customer').get()).exists, false);
    assert.equal((await db.doc(`customerContacts/${contactKey}`).get()).exists, false);
    assert.equal((await db.doc('auditLogs/historical').get()).data().type, 'customer.created');
    const events = await db.collection('auditLogs').where('type', '==', 'customer.deleted').get();
    assert.ok(events.docs.some(doc => doc.data().actorUid === uid && doc.data().detail.before.fullName === customer.fullName));
  }
});
test('all order statuses and transaction types block deletion without cascading', async () => {
  for (const status of ['draft', 'confirmed', 'cancelled', 'delivered', 'in_preparation', 'ready']) {
    await db.doc('orders/reference').set({ customerId: 'customer', status });
    await assert.rejects(remove(), { message: CUSTOMER_LINKED_MESSAGE });
  }
  await db.doc('orders/reference').delete();
  for (const collection of ['invoices', 'payments', 'paymentReversals', 'purchases', 'inventoryMovements']) {
    const ref = db.doc(`${collection}/reference`);
    await ref.set({ customerId: 'customer' });
    await assert.rejects(remove(), { message: CUSTOMER_LINKED_MESSAGE });
    assert.equal((await ref.get()).exists, true);
    await ref.delete();
  }
  assert.equal((await db.doc('customers/customer').get()).exists, true);
  assert.equal((await db.doc(`customerContacts/${contactKey}`).get()).exists, true);
});
test('legacy snapshots and permanent order links block deletion', async () => {
  await db.doc('payments/legacy').set({ customerSnapshot: { contact: customer.contact }, orderId: 'missing-order' });
  await assert.rejects(remove(), { message: CUSTOMER_LINKED_MESSAGE });
  await db.doc('payments/legacy').delete();
  await db.doc('customers/customer').update({ orderLinks: { user: 'cancelled-or-missing-order' } });
  await assert.rejects(remove(), { message: CUSTOMER_LINKED_MESSAGE });
});
test('Admin, User, anonymous, missing and inactive profiles cannot delete', async () => {
  for (const uid of ['', 'admin', 'user', 'missing', 'inactive']) await assert.rejects(remove(uid));
  assert.equal((await db.doc('customers/customer').get()).exists, true);
});
test('missing reservation is safe; mismatched reservation fails without deleting anything', async () => {
  await db.doc(`customerContacts/${contactKey}`).update({ customerId: 'another-customer' });
  await assert.rejects(remove(), /administrative review/);
  assert.equal((await db.doc('customers/customer').get()).exists, true);
  await db.doc(`customerContacts/${contactKey}`).delete();
  await remove();
  const events = await db.collection('auditLogs').where('type', '==', 'customer.deleted').get();
  assert.equal(events.docs[0].data().detail.reservationReleased, false);
});
test('concurrent real order creation and deletion never leave a dangling order', async () => {
  await db.doc('units/kg').set({ name: 'Kilogram', symbol: 'kg', active: true });
  await db.doc('items/sweet').set({ itemCode: 'SWEET', name: 'Sweet', defaultUnitId: 'kg', defaultSellingPrice: 100, active: true });
  const draft = { orderId: 'competing-order', customerId: 'customer', assignedUserId: 'user', orderDate: '2026-10-10', notes: '', lines: [{ kind: 'item', productId: 'sweet', quantityQty: 1000 }] };
  const outcomes = await Promise.allSettled([remove(), saveOrderDraft(db, 'admin', draft)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const order = await db.doc('orders/competing-order').get(), remaining = await db.doc('customers/customer').get();
  assert.equal(order.exists, remaining.exists);
});
