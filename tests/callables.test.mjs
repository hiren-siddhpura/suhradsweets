import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { getAuth as getClientAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, deleteApp: deleteAdminApp } = require('firebase-admin/app');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-suh-oms') throw new Error('Run through demo Auth, Firestore and Functions emulators.');
const admin = initializeAdminApp({ projectId: 'demo-suh-oms' }, 'callables-test');
const db = getFirestore(admin);
const client = initializeClientApp({ apiKey: 'demo-key', authDomain: 'demo-suh-oms.firebaseapp.com', projectId: 'demo-suh-oms', appId: 'demo-callables' }, 'callables-test');
const auth = getClientAuth(client);
connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
const functions = getFunctions(client, 'us-central1');
connectFunctionsEmulator(functions, '127.0.0.1', Number(process.env.OMS_FUNCTIONS_TEST_PORT || 5001));

test.after(async () => { await signOut(auth).catch(() => {}); await deleteClientApp(client); await deleteAdminApp(admin); });

test('callables reject anonymous and User, then accept Admin and Account Admin', async () => {
  const draft = { quantity: 2.5, supplierName: 'Emulator supplier', purchaseDate: '2026-10-10', purchaseTypeId: 'local', notes: '', documentUrl: '', totalPaise: 5000, paidAmountPaise: 0 };
  await assert.rejects(httpsCallable(functions, 'savePurchaseDraftCall')(draft), /Sign in is required/);
  await getAdminAuth(admin).createUser({ uid: 'callableUser', email: 'callable-user@example.test', password: 'LocalOnly123!' });
  await getAdminAuth(admin).createUser({ uid: 'callableAdmin', email: 'callable-admin@example.test', password: 'LocalOnly123!' });
  await getAdminAuth(admin).createUser({ uid: 'callableAccount', email: 'callable-account@example.test', password: 'LocalOnly123!' });
  await Promise.all([
    db.doc('users/callableUser').set({ role: 'user', active: true, displayName: 'User' }),
    db.doc('users/callableAdmin').set({ role: 'admin', active: true, displayName: 'Admin' }),
    db.doc('users/callableAccount').set({ role: 'account_admin', active: true, displayName: 'Account Admin' }),
    db.doc('items/sweetA').set({ itemCode: 'SWEET01', name: 'Sweet A', active: true, defaultUnitId: 'kg', defaultSellingPrice: 100 }),
    db.doc('units/kg').set({ name: 'Kilogram', symbol: 'kg', active: true }),
    db.doc('purchaseTypes/local').set({ name: 'Local', active: true }),
  ]);
  await signInWithEmailAndPassword(auth, 'callable-user@example.test', 'LocalOnly123!');
  await assert.rejects(httpsCallable(functions, 'savePurchaseDraftCall')(draft), /access is required/i);
  await signOut(auth);
  await signInWithEmailAndPassword(auth, 'callable-admin@example.test', 'LocalOnly123!');
  const created = (await httpsCallable(functions, 'savePurchaseDraftCall')(draft)).data;
  assert.equal((await db.doc(`purchases/${created.purchaseId}`).get()).data().status, 'draft');
  await httpsCallable(functions, 'confirmPurchaseCall')({ purchaseId: created.purchaseId });
  assert.equal((await db.doc('inventory/sweetA').get()).exists, false);
  await signOut(auth);
  await signInWithEmailAndPassword(auth, 'callable-account@example.test', 'LocalOnly123!');
  await httpsCallable(functions, 'adjustStockCall')({ itemId: 'sweetA', countedQty: 1500, reason: 'Count', operationId: 'accountCount' });
  assert.equal((await db.doc('inventory/sweetA').get()).data().onHandQty, 1500);
  const customer = (await httpsCallable(functions, 'saveCustomerCall')({ fullName: 'Local Customer', contact: '9998887777', address: 'Local street', area: 'Local', dateOfBirth: null, sabha: true })).data;
  assert.ok(customer.customerId);
  await signOut(auth);
  await signInWithEmailAndPassword(auth, 'callable-user@example.test', 'LocalOnly123!');
  const order = (await httpsCallable(functions, 'saveOrderDraftCall')({ newCustomer: { fullName: 'Own Customer', contact: '8887776666', address: 'Own street', area: 'Local', dateOfBirth: null, sabha: false }, assignedUserId: 'callableUser', orderDate: '2026-10-10', deliveryDate: null, notes: '', lines: [{ kind: 'item', productId: 'sweetA', quantityQty: 1000 }] })).data;
  assert.equal((await db.doc('inventory/sweetA').get()).data().onHandQty, 1500);
  await httpsCallable(functions, 'createInvoiceFromOrderCall')({ orderId: order.orderId });
  assert.equal((await db.doc('inventory/sweetA').get()).data().onHandQty, 500);
  assert.equal((await db.doc(`orders/${order.orderId}`).get()).data().status, 'in_preparation');
  await assert.rejects(httpsCallable(functions, 'createInvoiceFromOrderCall')({ orderId: order.orderId }), /already exists/);
});
