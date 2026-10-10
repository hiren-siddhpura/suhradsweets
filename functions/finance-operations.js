import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { audit, fail, money, text, validId } from './operations.js';

const staff = (role) => role === 'admin' || role === 'account_admin';
const validAmount = (value) => money(value) && value > 0;

async function actor(db, tx, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return snap.data().role;
}

function invoiceBalance(invoice) {
  if (!validAmount(invoice.totalPaise) || !money(invoice.verifiedPaidPaise) || invoice.verifiedPaidPaise > invoice.totalPaise) fail('Invoice balance is invalid. Contact an administrator.');
  return invoice.totalPaise - invoice.verifiedPaidPaise;
}

export async function submitPayment(db, uid, input) {
  if (!validId(input?.invoiceId) || !validAmount(input.amountPaise) || !['cash', 'upi', 'bank_transfer'].includes(input.mode)) fail('Choose an invoice, a positive amount and a valid payment mode.');
  const online = input.mode !== 'cash';
  if (input.transactionNumber != null && typeof input.transactionNumber !== 'string') fail('Transaction reference must be text.');
  const reference = online ? String(input.transactionNumber || '').trim().toUpperCase() : '-';
  if (online && (!text(reference, 100) || !/^[A-Z0-9][A-Z0-9/_-]*$/.test(reference))) fail('UPI and bank transfers require a valid transaction reference.');
  if (!online && input.transactionNumber && input.transactionNumber.trim() !== '-') fail('Cash transaction number must be -.');
  const invoiceRef = db.doc(`invoices/${input.invoiceId}`);
  const paymentRef = db.collection('payments').doc();
  const referenceRef = online ? db.doc(`paymentReferences/${createHash('sha256').update(reference).digest('hex')}`) : null;
  return db.runTransaction(async (tx) => {
    const role = await actor(db, tx, uid);
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists) fail('Invoice not found.');
    const invoice = invoiceSnap.data();
    if (!staff(role) && invoice.ownerUid !== uid) fail('You may submit payments only for your own invoices.');
    const order = await tx.get(db.doc(`orders/${invoice.orderId}`));
    if (!order.exists || order.data().ownerUid !== invoice.ownerUid) fail('Invoice ownership does not match its order.');
    if (invoice.paymentStatus === 'paid' || invoiceBalance(invoice) === 0) fail('This invoice has no outstanding balance.');
    if (input.amountPaise > invoiceBalance(invoice)) fail('Payment exceeds the current outstanding balance.');
    if (referenceRef && (await tx.get(referenceRef)).exists) fail('This online transaction reference has already been submitted.');
    if (referenceRef) tx.create(referenceRef, { paymentId: paymentRef.id, reference, createdAt: FieldValue.serverTimestamp() });
    tx.create(paymentRef, { invoiceId: invoiceRef.id, invoiceNumber: invoice.invoiceNumber, orderId: invoice.orderId, orderNumber: invoice.orderNumber, ownerUid: invoice.ownerUid, customerSnapshot: invoice.customerSnapshot, amountPaise: input.amountPaise, mode: input.mode, transactionNumber: reference, submittedBy: uid, submittedAt: FieldValue.serverTimestamp(), verificationStatus: 'unverified', verifiedBy: null, verifiedAt: null, receivedBy: null, reversalId: null });
    audit(tx, db, 'payment.submitted', uid, 'payment', paymentRef.id, { invoiceId: invoiceRef.id, amountPaise: input.amountPaise, mode: input.mode });
    return { paymentId: paymentRef.id };
  });
}

export async function reviewPayment(db, uid, input) {
  if (!validId(input?.paymentId) || !['verified', 'rejected'].includes(input.decision) || input.decision === 'rejected' && !text(input.reason, 500)) fail('Payment, decision and rejection reason are required.');
  const paymentRef = db.doc(`payments/${input.paymentId}`);
  return db.runTransaction(async (tx) => {
    if (!staff(await actor(db, tx, uid))) fail('Active Admin or Account Admin access is required.');
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists || paymentSnap.data().verificationStatus !== 'unverified') fail('Only an unverified payment can be reviewed.');
    const payment = paymentSnap.data();
    const invoiceRef = db.doc(`invoices/${payment.invoiceId}`);
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists || invoiceSnap.data().orderId !== payment.orderId || invoiceSnap.data().ownerUid !== payment.ownerUid) fail('Payment and invoice do not match.');
    const invoice = invoiceSnap.data();
    if (input.decision === 'verified') {
      if (invoice.paymentStatus === 'paid' || payment.amountPaise > invoiceBalance(invoice)) fail('Payment exceeds the current balance or invoice is already paid.');
      const next = invoice.verifiedPaidPaise + payment.amountPaise;
      tx.update(invoiceRef, { verifiedPaidPaise: next, paymentStatus: next === invoice.totalPaise ? 'ready_to_mark_paid' : 'partial' });
    }
    tx.update(paymentRef, { verificationStatus: input.decision, verifiedBy: uid, verifiedAt: FieldValue.serverTimestamp(), receivedBy: input.decision === 'verified' ? uid : null, reviewReason: input.decision === 'rejected' ? input.reason.trim() : null });
    audit(tx, db, `payment.${input.decision}`, uid, 'payment', paymentRef.id, { invoiceId: payment.invoiceId, amountPaise: payment.amountPaise, reason: input.decision === 'rejected' ? input.reason.trim() : null });
    return { paymentId: paymentRef.id, verificationStatus: input.decision };
  });
}

export async function reversePayment(db, uid, input) {
  if (!validId(input?.paymentId) || !text(input.reason, 500)) fail('Payment and reversal reason are required.');
  const paymentRef = db.doc(`payments/${input.paymentId}`);
  const reversalRef = db.doc(`paymentReversals/${input.paymentId}`);
  return db.runTransaction(async (tx) => {
    if (!staff(await actor(db, tx, uid))) fail('Active Admin or Account Admin access is required.');
    const paymentSnap = await tx.get(paymentRef);
    const reversal = await tx.get(reversalRef);
    if (!paymentSnap.exists || paymentSnap.data().verificationStatus !== 'verified' || reversal.exists || paymentSnap.data().reversalId) fail('Only an unreversed verified payment can be reversed.');
    const payment = paymentSnap.data();
    const invoiceRef = db.doc(`invoices/${payment.invoiceId}`);
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists || invoiceSnap.data().verifiedPaidPaise < payment.amountPaise) fail('Invoice balance cannot be reconciled.');
    const invoice = invoiceSnap.data();
    const next = invoice.verifiedPaidPaise - payment.amountPaise;
    tx.create(reversalRef, { paymentId: paymentRef.id, invoiceId: payment.invoiceId, amountPaise: payment.amountPaise, reason: input.reason.trim(), actorUid: uid, at: FieldValue.serverTimestamp() });
    tx.update(paymentRef, { reversalId: reversalRef.id });
    tx.update(invoiceRef, { verifiedPaidPaise: next, paymentStatus: next === 0 ? 'unpaid' : 'partial', ...(invoice.paymentStatus === 'paid' ? { paidReversedAt: FieldValue.serverTimestamp(), paidReversedBy: uid } : {}) });
    audit(tx, db, 'payment.reversed', uid, 'payment', paymentRef.id, { invoiceId: payment.invoiceId, amountPaise: payment.amountPaise, reason: input.reason.trim() });
    return { paymentId: paymentRef.id, reversalId: reversalRef.id };
  });
}

export async function markInvoicePaid(db, uid, input) {
  if (!validId(input?.invoiceId)) fail('Invoice ID is required.');
  const invoiceRef = db.doc(`invoices/${input.invoiceId}`);
  return db.runTransaction(async (tx) => {
    if (await actor(db, tx, uid) !== 'account_admin') fail('Account Admin access is required.');
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists) fail('Invoice not found.');
    const invoice = invoiceSnap.data();
    if (invoice.paymentStatus === 'paid') fail('Invoice is already marked paid.');
    invoiceBalance(invoice);
    const payments = await tx.get(db.collection('payments').where('invoiceId', '==', invoiceRef.id));
    let verified = 0;
    for (const snap of payments.docs) {
      const payment = snap.data();
      if (payment.orderId !== invoice.orderId || payment.ownerUid !== invoice.ownerUid) fail('Payment ownership does not reconcile.');
      if (payment.verificationStatus === 'verified' && !payment.reversalId) verified += payment.amountPaise;
    }
    if (!Number.isSafeInteger(verified) || verified !== invoice.verifiedPaidPaise || verified !== invoice.totalPaise) fail('Verified payments do not reconcile with the invoice total.');
    tx.update(invoiceRef, { paymentStatus: 'paid', paidBy: uid, paidAt: FieldValue.serverTimestamp() });
    audit(tx, db, 'invoice.marked_paid', uid, 'invoice', invoiceRef.id, { verifiedPaidPaise: verified, totalPaise: invoice.totalPaise });
    return { invoiceId: invoiceRef.id, paymentStatus: 'paid' };
  });
}
