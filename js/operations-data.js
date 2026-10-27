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
  const messages = {
    saveOrderDraft: 'Saving your order…', confirmOrder: 'Confirming order…', advanceOrder: 'Updating order status…', cancelOrder: 'Cancelling order…', archiveOrder: 'Archiving order…', restoreOrder: 'Restoring order…', reassignOrder: 'Updating assigned user…', requestOrderPayment: 'Recording payment request…', setOrderTaking: 'Updating order settings…', createInvoiceFromOrder: 'Creating invoice…',
    submitPayment: 'Submitting payment…', reviewPayment: 'Verifying payment…', changePaymentMode: 'Updating payment method…', reversePayment: 'Reversing payment…', markInvoicePaid: 'Marking invoice paid…',
    adjustStock: 'Updating inventory…', setInventoryControl: 'Updating stock controls…', savePurchaseDraft: 'Saving purchase order…', confirmPurchase: 'Confirming purchase…', cancelPurchase: 'Cancelling purchase…',
    saveUserProfile: 'Saving user account…', sendUserSetupLink: 'Sending password setup link…', saveCustomer: 'Saving customer…', deleteCustomer: 'Deleting customer…', saveSpecialProduct: 'Saving special product…', saveTarget: 'Saving target…', saveAnnouncement: 'Saving announcement…',
  };
  const token = messages[name] ? globalThis.omsLoading?.start(messages[name]) : null;
  try {
    const result = (await httpsCallable(functions, `${name}Call`)(data)).data;
    if (result == null) throw new Error('The server returned no result. Check the record before trying again.');
    return result;
  }
  catch (error) {
    const mode = contexts.get(functions) || 'unknown';
    const code = operationErrorCode(error);
    console.warn('[OMS operation]', { operation: /^[a-zA-Z]{1,60}$/.test(name) ? name : 'unknown', mode, code });
    const uncertain = token && ['unavailable', 'deadline-exceeded', 'internal', 'unknown'].includes(code);
    const failure = new Error(`${operationErrorMessage(error, mode)}${uncertain ? ' The result may be uncertain. Check the record before submitting again.' : ''}`);
    failure.code = code;
    throw failure;
  } finally { globalThis.omsLoading?.stop(token); }
};
