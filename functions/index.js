import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { OperationError, savePurchaseDraft, confirmPurchase, cancelPurchase, adjustStock, setInventoryControl } from './operations.js';
import { saveCustomer, saveSpecialProduct, saveOrderDraft, reassignOrder, confirmOrder, cancelOrder, advanceOrder, setOrderTaking, createInvoiceFromOrder, archiveOrder, restoreOrder, requestOrderPayment } from './order-operations.js';
import { submitPayment, reviewPayment, changePaymentMode, reversePayment, markInvoicePaid, readPaymentReceipt } from './finance-operations.js';
import { submitCollection, reviewCollection, readCollectionReceipt } from './collection-operations.js';
import { saveTarget, saveAnnouncement, saveUserProfile } from './reporting-operations.js';
import { deleteCustomer } from './customer-operations.js';
import { manageUser, sendUserSetupLink } from './user-operations.js';
import { getOrderStock, getPaymentNames, listOrderActivity, listPaymentActivity } from './order-reads.js';
import { getOrderAnalytics } from './order-analytics.js';

initializeApp();
const db = getFirestore();
const operations = { submitCollection, reviewCollection, readCollectionReceipt, readPaymentReceipt, savePurchaseDraft, confirmPurchase, cancelPurchase, adjustStock, setInventoryControl, saveCustomer, saveSpecialProduct, saveOrderDraft, reassignOrder, confirmOrder, cancelOrder, advanceOrder, setOrderTaking, createInvoiceFromOrder, archiveOrder, restoreOrder, requestOrderPayment, getOrderStock, getPaymentNames, listOrderActivity, listPaymentActivity, getOrderAnalytics, submitPayment, reviewPayment, changePaymentMode, reversePayment, markInvoicePaid, saveTarget, saveAnnouncement, saveUserProfile };

function callable(name) {
  return onCall({ region: 'us-central1', maxInstances: 3, cors: true }, async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in is required.');
    try {
      const data = request.data || {};
      if (name === 'saveUserProfile') return await manageUser(db, request.auth.uid, data);
      if (name === 'sendUserSetupLink') return await sendUserSetupLink(db, request.auth.uid, data);
      if (name === 'deleteCustomer') return await deleteCustomer(db, request.auth.uid, data);
      if (['submitCollection', 'reviewCollection', 'readCollectionReceipt', 'readPaymentReceipt', 'savePurchaseDraft', 'adjustStock', 'setInventoryControl', 'saveCustomer', 'saveSpecialProduct', 'saveOrderDraft', 'reassignOrder', 'archiveOrder', 'restoreOrder', 'requestOrderPayment', 'getOrderStock', 'getPaymentNames', 'listOrderActivity', 'listPaymentActivity', 'getOrderAnalytics', 'submitPayment', 'reviewPayment', 'changePaymentMode', 'reversePayment', 'markInvoicePaid', 'saveTarget', 'saveAnnouncement', 'saveUserProfile'].includes(name)) return await operations[name](db, request.auth.uid, data);
      if (name === 'cancelPurchase') return await operations[name](db, request.auth.uid, data.purchaseId, data.reason);
      if (name === 'createInvoiceFromOrder') return await operations[name](db, request.auth.uid, data.orderId);
      if (name === 'confirmOrder') return await operations[name](db, request.auth.uid, data.orderId);
      if (name === 'cancelOrder') return await operations[name](db, request.auth.uid, data.orderId, data.reason);
      if (name === 'advanceOrder') return await operations[name](db, request.auth.uid, data.orderId, data.nextStatus);
      if (name === 'setOrderTaking') return await operations[name](db, request.auth.uid, data.acceptingOrders, data.reason);
      return await operations[name](db, request.auth.uid, data.purchaseId);
    } catch (error) {
      if (!(error instanceof OperationError)) {
        console.error('Trusted operation failed:', error);
        throw new HttpsError('internal', 'The operation could not be completed. Try again later.');
      }
      const code = error.message.includes('access is required') || error.message.includes('Access denied') ? 'permission-denied' : 'failed-precondition';
      throw new HttpsError(code, error.message);
    }
  });
}

export const savePurchaseDraftCall = callable('savePurchaseDraft');
export const confirmPurchaseCall = callable('confirmPurchase');
export const cancelPurchaseCall = callable('cancelPurchase');
export const adjustStockCall = callable('adjustStock');
export const setInventoryControlCall = callable('setInventoryControl');
export const saveCustomerCall = callable('saveCustomer');
export const deleteCustomerCall = callable('deleteCustomer');
export const saveSpecialProductCall = callable('saveSpecialProduct');
export const saveOrderDraftCall = callable('saveOrderDraft');
export const reassignOrderCall = callable('reassignOrder');
export const confirmOrderCall = callable('confirmOrder');
export const archiveOrderCall = callable('archiveOrder');
export const restoreOrderCall = callable('restoreOrder');
export const requestOrderPaymentCall = callable('requestOrderPayment');
export const getOrderStockCall = callable('getOrderStock');
export const getOrderAnalyticsCall = callable('getOrderAnalytics');
export const getPaymentNamesCall = callable('getPaymentNames');
export const listOrderActivityCall = callable('listOrderActivity');
export const listPaymentActivityCall = callable('listPaymentActivity');
export const cancelOrderCall = callable('cancelOrder');
export const advanceOrderCall = callable('advanceOrder');
export const setOrderTakingCall = callable('setOrderTaking');
export const createInvoiceFromOrderCall = callable('createInvoiceFromOrder');
export const submitPaymentCall = callable('submitPayment');
export const readPaymentReceiptCall = callable('readPaymentReceipt');
export const submitCollectionCall = callable('submitCollection');
export const reviewCollectionCall = callable('reviewCollection');
export const readCollectionReceiptCall = callable('readCollectionReceipt');
export const reviewPaymentCall = callable('reviewPayment');
export const changePaymentModeCall = callable('changePaymentMode');
export const reversePaymentCall = callable('reversePayment');
export const markInvoicePaidCall = callable('markInvoicePaid');
export const saveTargetCall = callable('saveTarget');
export const saveAnnouncementCall = callable('saveAnnouncement');
export const saveUserProfileCall = callable('saveUserProfile');
export const sendUserSetupLinkCall = callable('sendUserSetupLink');
