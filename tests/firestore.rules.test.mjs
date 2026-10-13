import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getAggregateFromServer, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, sum, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore';

let environment;
const projectId = process.env.OMS_RULES_TEST_PROJECT || 'demo-suh-oms'; // Emulator-only namespace; never a production project.
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const reportingSource = readFileSync(new URL('../js/reporting-data.js', import.meta.url), 'utf8')
  .replace('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js', import.meta.resolve('firebase/firestore'))
  .replace('./dashboard-metrics.js', new URL('../js/dashboard-metrics.js', import.meta.url).href);
const { dashboardOrderKg, dashboardStockKg, dashboardTargetKg } = await import(`data:text/javascript;base64,${Buffer.from(reportingSource).toString('base64')}`);

const dbFor = (uid) => uid ? environment.authenticatedContext(uid).firestore() : environment.unauthenticatedContext().firestore();
const record = (db, path) => doc(db, path);

async function seed() {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const profiles = {
      adminA: { role: 'admin', active: true, displayName: 'Admin A' },
      legacyAdmin: { role: 'admin', active: true, fullName: 'Legacy Admin' },
      accountA: { role: 'account_admin', active: true, displayName: 'Account A' },
      userA: { role: 'user', active: true, displayName: 'User A' },
      userB: { role: 'user', active: true, displayName: 'User B' },
      inactiveA: { role: 'user', active: false, displayName: 'Inactive A' },
      invalidA: { role: 'root', active: true, displayName: 'Invalid A' },
    };
    for (const [uid, profile] of Object.entries(profiles)) await setDoc(record(db, `users/${uid}`), profile);
    await setDoc(record(db, 'units/unitA'), { name: 'Kilogram', symbol: 'kg', active: true });
    await setDoc(record(db, 'units/unitInactive'), { name: 'Old unit', symbol: 'old', active: false });
    await setDoc(record(db, 'items/itemActive'), { itemCode: 'A001', name: 'Sweet', defaultSellingPrice: 100, defaultUnitId: 'unitA', active: true });
    await setDoc(record(db, 'items/itemInactive'), { itemCode: 'B001', name: 'Old sweet', defaultSellingPrice: 100, defaultUnitId: 'unitA', active: false });
    await setDoc(record(db, 'specialProducts/specialActive'), { name: 'Combo', finalPricePaise: 5000, active: true });
    await setDoc(record(db, 'specialProducts/specialA'), { name: 'Old combo', active: false });
    await setDoc(record(db, 'orderControls/global'), { acceptingOrders: true });
    await setDoc(record(db, 'orders/orderA'), { ownerUid: 'userA', customerId: 'customerA', status: 'confirmed', totalPaise: 5000, lines: [{ itemName: 'Sweet', quantity: 1 }] });
    await setDoc(record(db, 'orders/orderB'), { ownerUid: 'userB', customerId: 'customerB', status: 'draft' });
    await setDoc(record(db, 'customers/customerA'), { name: 'Customer A', orderLinks: { userA: 'orderA' } });
    await setDoc(record(db, 'customers/customerB'), { name: 'Customer B', orderLinks: { userB: 'orderB' } });
    await setDoc(record(db, 'invoices/invoiceA'), { ownerUid: 'userA', orderId: 'orderA', paymentStatus: 'unpaid', paidAt: null, paidBy: null, totalPaise: 5000 });
    await setDoc(record(db, 'invoices/invoiceB'), { ownerUid: 'userB', orderId: 'orderB', paymentStatus: 'unpaid', paidAt: null, paidBy: null, totalPaise: 2000 });
    await setDoc(record(db, 'payments/paymentA'), { ownerUid: 'userA', invoiceId: 'invoiceA', method: 'upi', amountPaise: 2500, verificationStatus: 'unverified' });
    await setDoc(record(db, 'payments/paymentB'), { ownerUid: 'userB', invoiceId: 'invoiceB', method: 'cash', amountPaise: 2000, verificationStatus: 'verified' });
    await setDoc(record(db, 'paymentReversals/paymentA'), { paymentId: 'paymentA', invoiceId: 'invoiceA', amountPaise: 2500, actorUid: 'adminA' });
    await setDoc(record(db, 'inventory/itemA'), { quantity: 10 });
    await setDoc(record(db, 'purchases/purchaseA'), { status: 'draft', supplierName: 'Supplier A' });
    await setDoc(record(db, 'inventoryMovements/movementA'), { ownerUid: 'userA', itemId: 'itemA', movementType: 'order_confirm', changeQty: -1000 });
    await setDoc(record(db, 'inventoryMovements/movementPrivate'), { ownerUid: null, itemId: 'itemA', movementType: 'purchase_confirm', changeQty: 1000 });
    await setDoc(record(db, 'auditLogs/auditA'), { actorUid: 'adminA', type: 'order.confirmed' });
    await setDoc(record(db, 'targets/targetA'), { ownerUid: 'userA', periodType: 'daily', active: true });
    await setDoc(record(db, 'targets/targetB'), { ownerUid: 'userB', periodType: 'weekly', active: true });
    await setDoc(record(db, 'announcements/annA'), { title: 'Welcome', audience: 'all', active: true });
    await setDoc(record(db, 'announcements/annStaff'), { title: 'Staff', audience: 'staff', active: true });
    await setDoc(record(db, 'announcements/annInactive'), { title: 'Old', audience: 'all', active: false });
  });
}

test.before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { rules } });
});
test.beforeEach(async () => { await environment.clearFirestore(); await seed(); });
test.after(async () => { if (environment) await environment.cleanup(); });

test('financial documents and reference reservations reject direct client writes', async () => {
  for (const uid of ['adminA', 'accountA', 'userA', 'userB']) {
    const db = dbFor(uid);
    await assertFails(setDoc(record(db, 'invoices/newInvoice'), { ownerUid: uid, paymentStatus: 'paid' }));
    await assertFails(updateDoc(record(db, 'invoices/invoiceA'), { paymentStatus: 'paid', paidBy: uid }));
    await assertFails(setDoc(record(db, 'payments/newPayment'), { ownerUid: uid, verificationStatus: 'verified', amountPaise: 5000 }));
    await assertFails(updateDoc(record(db, 'payments/paymentA'), { verificationStatus: 'verified', verifiedBy: uid }));
    await assertFails(setDoc(record(db, 'paymentReferences/ref'), { paymentId: 'newPayment' }));
    await assertFails(setDoc(record(db, 'paymentReversals/paymentB'), { actorUid: uid }));
    await assertFails(deleteDoc(record(db, 'payments/paymentA')));
  }
  await assertSucceeds(getDoc(record(dbFor('userA'), 'paymentReversals/paymentA')));
  await assertFails(getDoc(record(dbFor('userB'), 'paymentReversals/paymentA')));
});

test('purchase, stock and movement writes are denied directly for every client role', async () => {
  for (const uid of ['adminA', 'accountA', 'userA']) {
    const db = dbFor(uid);
    await assertFails(setDoc(record(db, 'purchases/newPurchase'), { status: 'draft' }));
    await assertFails(updateDoc(record(db, 'purchases/purchaseA'), { status: 'confirmed' }));
    await assertFails(updateDoc(record(db, 'inventory/itemA'), { onHandQty: 999999 }));
    await assertFails(setDoc(record(db, 'inventoryMovements/forged'), { ownerUid: uid, changeQty: 999 }));
    await assertFails(setDoc(record(db, 'auditLogs/forged'), { actorUid: uid, type: 'inventory.adjusted' }));
  }
});

test('normal user sees only own order-linked movement records', async () => {
  await assertSucceeds(getDoc(record(dbFor('userA'), 'inventoryMovements/movementA')));
  await assertFails(getDoc(record(dbFor('userB'), 'inventoryMovements/movementA')));
  await assertFails(getDoc(record(dbFor('userA'), 'inventoryMovements/movementPrivate')));
  await assertFails(getDocs(collection(dbFor('userA'), 'inventoryMovements')));
  await assertSucceeds(getDocs(query(collection(dbFor('userA'), 'inventoryMovements'), where('ownerUid', '==', 'userA'))));
  await assertFails(getDoc(record(dbFor('userA'), 'purchases/purchaseA')));
  await assertFails(getDoc(record(dbFor('userA'), 'inventory/itemA')));
  await assertSucceeds(getDoc(record(dbFor('adminA'), 'purchases/purchaseA')));
});

test('anonymous, missing and inactive profiles cannot read operational data', async () => {
  await assertSucceeds(getDoc(record(dbFor('legacyAdmin'), 'orders/orderA')));
  await assertFails(getDoc(record(dbFor(null), 'orders/orderA')));
  await assertFails(getDoc(record(dbFor(null), 'users/userA')));
  await assertFails(getDoc(record(dbFor('missingA'), 'orders/orderA')));
  await assertFails(getDoc(record(dbFor('inactiveA'), 'orders/orderA')));
  await assertFails(getDoc(record(dbFor('invalidA'), 'orders/orderA')));
  assert.equal((await assertSucceeds(getDoc(record(dbFor('inactiveA'), 'users/inactiveA')))).exists(), true);
});

test('target achievement aggregates confirmed sales only for the owned User', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const at = Timestamp.fromDate(new Date('2026-10-10T08:00:00+05:30'));
    for (const [id, ownerUid, status, grandTotal] of [
      ['eligibleA', 'userA', 'confirmed', 1200],
      ['deliveredA', 'userA', 'delivered', 300],
      ['cancelledA', 'userA', 'cancelled', 9000],
      ['otherUser', 'userB', 'confirmed', 8000],
    ]) await setDoc(record(db, `orders/${id}`), { ownerUid, status, grandTotal, confirmedAt: at });
  });
  const db = dbFor('userA');
  const eligible = query(collection(db, 'orders'), where('ownerUid', '==', 'userA'), where('status', 'in', ['confirmed', 'in_preparation', 'ready', 'delivered']), where('confirmedAt', '>=', Timestamp.fromDate(new Date('2026-10-10T00:00:00+05:30'))), where('confirmedAt', '<', Timestamp.fromDate(new Date('2026-10-11T00:00:00+05:30'))));
  const result = await assertSucceeds(getAggregateFromServer(eligible, { eligibleSalesPaise: sum('grandTotal') }));
  assert.equal(result.data().eligibleSalesPaise, 1500);
  await assertFails(getAggregateFromServer(query(collection(db, 'orders'), where('ownerUid', '==', 'userB')), { sales: sum('grandTotal') }));
});

test('reporting date and prefix queries remain permitted for their roles', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(record(db, 'targets/currentA'), { ownerUid: 'userA', active: true, periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    await setDoc(record(db, 'announcements/currentA'), { active: true, audience: 'all', titleKey: 'welcome', startsOn: '2026-10-01', expiresOn: '2026-10-31' });
  });
  const user = dbFor('userA');
  await assertSucceeds(getDocs(query(collection(user, 'targets'), where('ownerUid', '==', 'userA'), where('active', '==', true), where('periodStart', '<=', '2026-10-10'), where('periodEnd', '>=', '2026-10-10'), orderBy('periodStart', 'desc'))));
  await assertSucceeds(getDocs(query(collection(user, 'announcements'), where('active', '==', true), where('audience', 'in', ['all', 'users']), where('startsOn', '<=', '2026-10-10'), where('expiresOn', '>=', '2026-10-10'), orderBy('startsOn', 'desc'))));
  await assertSucceeds(getDocs(query(collection(dbFor('adminA'), 'announcements'), where('titleKey', '>=', 'wel'), where('titleKey', '<=', 'wel\uf8ff'), where('startsOn', '>=', '2026-10-01'), orderBy('titleKey'))));
});

test('Users read only owned orders, invoices, payments and linked customers', async () => {
  const db = dbFor('userA');
  for (const path of ['users/userA', 'orders/orderA', 'invoices/invoiceA', 'payments/paymentA', 'customers/customerA']) {
    await assertSucceeds(getDoc(record(db, path)));
  }
  for (const path of ['users/userB', 'orders/orderB', 'invoices/invoiceB', 'payments/paymentB', 'customers/customerB', 'inventory/itemA']) {
    await assertFails(getDoc(record(db, path)));
  }
  await assertSucceeds(getDocs(query(collection(db, 'orders'), where('ownerUid', '==', 'userA'))));
  await assertFails(getDocs(collection(db, 'orders')));
  await assertFails(getDocs(collection(db, 'customers')));
});

test('Users can query active catalog and global order status but cannot edit them', async () => {
  const db = dbFor('userA');
  for (const path of ['items/itemActive', 'units/unitA', 'specialProducts/specialActive', 'orderControls/global']) await assertSucceeds(getDoc(record(db, path)));
  for (const path of ['items/itemInactive', 'specialProducts/specialA']) await assertFails(getDoc(record(db, path)));
  await assertSucceeds(getDoc(record(db, 'units/unitInactive'))); // An active item may still use a deactivated unit.
  await assertFails(getDocs(collection(db, 'units')));
  await assertSucceeds(getDocs(query(collection(db, 'items'), where('active', '==', true))));
  await assertSucceeds(getDocs(query(collection(db, 'specialProducts'), where('active', '==', true))));
  await assertFails(getDocs(collection(db, 'items')));
  await assertFails(setDoc(record(db, 'orderControls/global'), { acceptingOrders: false }));
  await assertFails(updateDoc(record(db, 'customers/customerA'), { ownerUserIds: ['userA', 'userB'] }));
});

test('all client roles are denied order, special, invoice, counter and malformed customer writes', async () => {
  for (const uid of ['adminA', 'accountA', 'userA']) {
    const db = dbFor(uid);
    await assertFails(setDoc(record(db, 'orders/newOrder'), { ownerUid: uid, status: 'draft' }));
    await assertFails(updateDoc(record(db, 'orders/orderA'), { status: 'confirmed' }));
    await assertFails(setDoc(record(db, 'customers/newCustomer'), { ownerUserIds: [uid] }));
    await assertFails(updateDoc(record(db, 'customers/customerA'), { orderLinks: { [uid]: 'orderA' } }));
    await assertFails(setDoc(record(db, 'specialProducts/newCombo'), { active: true }));
    await assertFails(setDoc(record(db, 'invoices/newInvoice'), { paymentStatus: 'unpaid' }));
    await assertFails(setDoc(record(db, 'orderCounters/2026'), { nextNumber: 1 }));
    await assertFails(setDoc(record(db, 'customerContacts/forged'), { customerId: 'customerA' }));
  }
});

test('staff can read named modules but no one gets an unknown collection', async () => {
  for (const uid of ['adminA', 'accountA']) {
    const db = dbFor(uid);
    for (const path of ['users/userB', 'orders/orderB', 'inventory/itemA', 'auditLogs/auditA', 'units/unitA']) {
      await assertSucceeds(getDoc(record(db, path)));
    }
    await assertSucceeds(getDocs(collection(db, 'users')));
    await assertFails(getDoc(record(db, 'unknown/secret')));
  }
  await assertFails(getDocs(collection(dbFor('userA'), 'users')));
});

test('remaining operational collections are staff-readable and client-write protected', async () => {
  const paths = ['inventoryMovements/moveA', 'purchases/purchaseA', 'specialProducts/specialA', 'targets/targetA', 'announcements/annA'];
  for (const path of paths) {
    await assertSucceeds(getDoc(record(dbFor('adminA'), path)));
    await assertSucceeds(getDoc(record(dbFor('accountA'), path)));
    if (path.startsWith('targets/') || path.startsWith('announcements/')) await assertSucceeds(getDoc(record(dbFor('userA'), path)));
    else await assertFails(getDoc(record(dbFor('userA'), path)));
    await assertFails(setDoc(record(dbFor('adminA'), path), { createdBy: 'adminA' }));
  }
  await assertFails(getDoc(record(dbFor('adminA'), 'products/legacy')));
  await assertFails(setDoc(record(dbFor('userA'), 'authEvents/legacy'), { uid: 'userA' }));
  for (const uid of ['adminA', 'accountA', 'userA']) {
    for (const path of ['userOperations/forged', 'userOperationLocks/userA']) {
      await assertFails(getDoc(record(dbFor(uid), path)));
      await assertFails(setDoc(record(dbFor(uid), path), { actorUid: uid, status: 'completed' }));
      await assertFails(deleteDoc(record(dbFor(uid), path)));
    }
  }
});

test('self role changes and Account Admin staff promotion are denied', async () => {
  await assertFails(updateDoc(record(dbFor('userA'), 'users/userA'), { role: 'admin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(dbFor('adminA'), 'users/adminA'), { role: 'account_admin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(dbFor('accountA'), 'users/userA'), { role: 'admin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(dbFor('accountA'), 'users/adminA'), { active: false, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(dbFor('adminA'), 'users/userA'), { role: 'account_admin', updatedAt: serverTimestamp() }));
});

test('Users read only their targets and active permitted announcements', async () => {
  const user = dbFor('userA');
  await assertSucceeds(getDoc(record(user, 'targets/targetA')));
  await assertFails(getDoc(record(user, 'targets/targetB')));
  await assertSucceeds(getDocs(query(collection(user, 'targets'), where('ownerUid', '==', 'userA'))));
  await assertFails(getDocs(collection(user, 'targets')));
  await assertSucceeds(getDoc(record(user, 'announcements/annA')));
  await assertFails(getDoc(record(user, 'announcements/annStaff')));
  await assertFails(getDoc(record(user, 'announcements/annInactive')));
  await assertSucceeds(getDocs(query(collection(user, 'announcements'), where('active', '==', true), where('audience', 'in', ['all', 'users']))));
  await assertFails(getDocs(collection(user, 'announcements')));
  for (const uid of ['adminA', 'accountA', 'userA']) {
    await assertFails(setDoc(record(dbFor(uid), 'targets/forged'), { ownerUid: uid, targetPaise: 1 }));
    await assertFails(updateDoc(record(dbFor(uid), 'announcements/annA'), { active: false }));
  }
});

test('direct invoice paid and payment verification writes fail for every role', async () => {
  for (const uid of ['adminA', 'accountA', 'userA']) {
    const db = dbFor(uid);
    await assertFails(updateDoc(record(db, 'invoices/invoiceA'), { paymentStatus: 'paid', paidBy: uid, paidAt: serverTimestamp() }));
    await assertFails(updateDoc(record(db, 'invoices/invoiceA'), { paymentStatus: 'in_process' }));
    await assertFails(updateDoc(record(db, 'payments/paymentA'), { verificationStatus: 'verified' }));
    await assertFails(updateDoc(record(db, 'payments/paymentA'), { mode: 'cash', transactionNumber: '-' }));
    await assertFails(updateDoc(record(db, 'payments/paymentA'), { ownerUid: uid }));
  }
});

test('stock, confirmations, snapshots and audit history reject direct client writes', async () => {
  for (const uid of ['adminA', 'accountA', 'userA']) {
    const db = dbFor(uid);
    await assertFails(updateDoc(record(db, 'orders/orderA'), { status: 'confirmed', totalPaise: 1, lines: [] }));
    await assertFails(updateDoc(record(db, 'inventory/itemA'), { quantity: 999 }));
    await assertFails(setDoc(record(db, 'inventoryMovements/fake'), { quantityDelta: 999 }));
    await assertFails(setDoc(record(db, 'purchases/fake'), { status: 'confirmed' }));
    await assertFails(setDoc(record(db, 'auditLogs/fake'), { actorUid: uid, type: 'payment.verified' }));
    await assertFails(updateDoc(record(db, 'auditLogs/auditA'), { type: 'edited' }));
    await assertFails(deleteDoc(record(db, 'auditLogs/auditA')));
  }
});

test('login logs bind identity and server time but are client best-effort', async () => {
  const db = dbFor('userA');
  await assertSucceeds(setDoc(record(db, 'loginLogs/good'), { uid: 'userA', type: 'login', at: serverTimestamp() }));
  await assertFails(setDoc(record(db, 'loginLogs/spoof'), { uid: 'userB', type: 'login', at: serverTimestamp() }));
  await assertFails(setDoc(record(db, 'loginLogs/client-time'), { uid: 'userA', type: 'login', at: new Date() }));
  await assertFails(updateDoc(record(db, 'loginLogs/good'), { type: 'logout' }));
  await assertFails(deleteDoc(record(db, 'loginLogs/good')));
});

test('dashboard KG target is staff-managed and only that setting is readable by Users', async () => {
  const admin = dbFor('adminA'), user = dbFor('userA');
  const target = { key: 'dashboardSalesTargetKg', value: '250.125', description: 'Confirmed KG sales target', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(record(admin, 'settings/dashboard_sales_target'), target));
  await assertSucceeds(getDoc(record(user, 'settings/dashboard_sales_target')));
  assert.equal(await dashboardTargetKg(user), 250.125);
  await assertFails(getDocs(collection(user, 'settings')));
  await assertFails(setDoc(record(user, 'settings/dashboard_sales_target'), target));
  await assertFails(updateDoc(record(admin, 'settings/dashboard_sales_target'), { value: '-1', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(record(admin, 'settings/duplicate_target'), target));
  await assertSucceeds(updateDoc(record(dbFor('accountA'), 'settings/dashboard_sales_target'), { value: '0', updatedAt: serverTimestamp() }));
});

test('business details preserve FSSAI text and only Admin may write the fixed document', async () => {
  const admin = dbFor('adminA'), account = dbFor('accountA'), user = dbFor('userA');
  const path = 'settings/business_details';
  const details = { key: 'businessDetails', address: '', contactNumber: '', fssaiLicenseNo: '00123456789012', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertFails(setDoc(record(account, path), details));
  await assertFails(setDoc(record(user, path), details));
  await assertSucceeds(setDoc(record(admin, path), details));
  assert.equal((await getDoc(record(user, path))).data().fssaiLicenseNo, '00123456789012');
  await assertSucceeds(updateDoc(record(admin, path), { fssaiLicenseNo: '00012345678901', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(account, path), { fssaiLicenseNo: '999', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(user, path), { address: 'Other', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(admin, path), { key: 'other', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(record(admin, path), { fssaiLicenseNo: '<script>', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(record(admin, path)));
  await assertFails(getDocs(collection(user, 'settings')));
});

test('dashboard KG data layer returns authorized sales and item-wise sellable stock', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(record(db, 'units/kgUnit'), { name: 'Kilogram', symbol: 'kg', active: true });
    await setDoc(record(db, 'units/gUnit'), { name: 'Gram', symbol: 'g', active: true });
    await setDoc(record(db, 'items/kgItem'), { name: 'Sweet', defaultUnitId: 'kgUnit', active: true });
    await setDoc(record(db, 'items/gItem'), { name: 'Small Sweet', defaultUnitId: 'gUnit', active: true });
    await setDoc(record(db, 'inventory/kgItem'), { onHandQty: 12000, reservedQty: 0, sellingBlocked: false });
    await setDoc(record(db, 'inventory/gItem'), { onHandQty: 500000, reservedQty: 0, sellingBlocked: false });
    for (const [id, ownerUid, status, quantityQty] of [['mine', 'userA', 'confirmed', 2500], ['theirs', 'userB', 'confirmed', 5000], ['cancelled', 'userA', 'cancelled', 8000]]) {
      await setDoc(record(db, `orders/${id}`), { orderDate: '2026-10-10', ownerUid, status, stockDeductions: [{ itemId: 'kgItem', quantityQty, itemSnapshot: { name: 'Sweet', unitSymbol: 'kg' } }] });
    }
  });
  const user = dbFor('userA'), admin = dbFor('adminA');
  const own = await dashboardOrderKg(user, 'user', 'userA', '2026-10-10', '2026-10-10');
  assert.equal(own.orderCount, 1); assert.equal(own.totalKg, 2.5);
  const all = await dashboardOrderKg(admin, 'admin', 'adminA', '2026-10-10', '2026-10-10');
  assert.equal(all.orderCount, 2); assert.equal(all.totalKg, 7.5);
  const stock = await dashboardStockKg(admin);
  assert.equal(stock.totalKg, 12.5);
  assert.equal(stock.items.length, 2);
  await environment.withSecurityRulesDisabled(async (context) => {
    await updateDoc(record(context.firestore(), 'inventory/kgItem'), { sellingBlocked: true });
  });
  const blockedStock = await dashboardStockKg(admin);
  assert.equal(blockedStock.totalKg, 0.5);
  assert.equal(blockedStock.items.find((item) => item.itemId === 'kgItem').kg, 0);
  const userStock = await assertSucceeds(dashboardStockKg(user, 'user'));
  assert.equal(userStock.totalKg, 0.5);
  assert.equal(userStock.items.length, 3); // Active items without inventory display zero stock.
  assert.equal(userStock.items.find((item) => item.itemId === 'itemActive').kg, 0);
  assert.equal((await assertSucceeds(dashboardStockKg(dbFor('accountA'), 'account_admin'))).totalKg, 0.5);
  await assertSucceeds(getDoc(record(user, 'inventory/kgItem')));
  await assertFails(getDocs(collection(user, 'inventory')));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(record(context.firestore(), 'items/inactiveStockItem'), { name: 'Hidden sweet', defaultUnitId: 'kgUnit', active: false });
    await setDoc(record(context.firestore(), 'inventory/inactiveStockItem'), { onHandQty: 1000, reservedQty: 0, sellingBlocked: false });
  });
  await assertFails(getDoc(record(user, 'inventory/inactiveStockItem')));
  await assertFails(getDoc(record(dbFor('inactiveA'), 'inventory/kgItem')));
  await assertFails(getDoc(record(dbFor(null), 'inventory/kgItem')));
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(record(db, 'units/legacyKg'), { name: 'Legacy kilogram', symbol: 'kg', active: false });
    await setDoc(record(db, 'items/legacyStockItem'), { name: 'Legacy sweet', defaultUnitId: 'legacyKg', active: true });
    await setDoc(record(db, 'inventory/legacyStockItem'), { onHandQty: 1000, reservedQty: 0, sellingBlocked: false });
  });
  assert.equal((await assertSucceeds(dashboardStockKg(user, 'user'))).totalKg, 1.5);
});

test('item code reservation is atomic, and User cannot write master data', async () => {
  const db = dbFor('adminA');
  const batch = writeBatch(db);
  batch.set(record(db, 'items/itemA'), { itemCode: 'SW-01', name: 'Sweet', description: '', defaultSellingPrice: 12.5, defaultUnitId: 'unitA', active: true, createdBy: 'adminA', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(record(db, 'itemCodes/SW-01'), { itemId: 'itemA', createdAt: serverTimestamp() });
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(record(db, 'items/itemB'), { itemCode: 'SW-01', name: 'Other', description: '', defaultSellingPrice: 1, defaultUnitId: 'unitA', active: true, createdBy: 'adminA', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertFails(setDoc(record(db, 'items/itemC'), { itemCode: 'SW-02', name: 'Other', description: '', defaultSellingPrice: 1, defaultUnitId: 'unitA', active: true, createdBy: 'adminA', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(record(db, 'units/unitA')));
  await assertFails(setDoc(record(dbFor('userA'), 'units/unitB'), { name: 'Box', symbol: 'box', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});
