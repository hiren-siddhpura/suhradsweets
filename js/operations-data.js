import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { operationErrorCode, operationErrorMessage } from './callable-error.js';

const contexts = new WeakMap();
export function configureOperations(functions, mode) { contexts.set(functions, mode); }

const unpack = (snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
export const listPurchases = async (db) => unpack(await getDocs(collection(db, 'purchases')));
export const listInventory = async (db) => unpack(await getDocs(collection(db, 'inventory')));
export const listMovements = async (db, ownerUid = null) => unpack(await getDocs(ownerUid
  ? query(collection(db, 'inventoryMovements'), where('ownerUid', '==', ownerUid))
  : collection(db, 'inventoryMovements')));
export const callOperation = async (functions, name, data) => {
  try { return (await httpsCallable(functions, `${name}Call`)(data)).data; }
  catch (error) {
    const mode = contexts.get(functions) || 'unknown';
    const code = operationErrorCode(error);
    console.warn('[OMS operation]', { operation: /^[a-zA-Z]{1,60}$/.test(name) ? name : 'unknown', mode, code });
    const failure = new Error(operationErrorMessage(error, mode));
    failure.code = code;
    throw failure;
  }
};
