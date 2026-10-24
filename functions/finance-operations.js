import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { audit, fail, money, text, validId } from './operations.js';
import { orderEvent } from './order-operations.js';
const staff = (role) => role === 'admin' || role === 'account_admin';

const validAmount = (value) => money(value) && value > 0;
const referenceFor = (mode, value) => {
  if (value != null && typeof value !== 'string') fail('Transaction reference must be text.');
  const reference = mode === 'cash' ? '-' : String(value || '').trim().toUpperCase();
  if (mode !== 'cash' && (!text(reference, 100) || !/^[A-Z0-9][A-Z0-9/_-]*$/.test(reference))) fail('UPI and bank transfers require a valid transaction reference.');
  if (mode === 'cash' && value && value.trim() !== '-') fail('Cash transaction number must be -.');
  return reference;
};
const referenceDoc = (db, reference) => db.doc(`paymentReferences/${createHash('sha256').update(reference).digest('hex')}`);
function paymentEvent(tx, db, type, identity, paymentId, payment, changedFields = {}, reason = '') {
  tx.create(db.collection('auditLogs').doc(), {
    type, actorUid: identity.uid, actorName: identity.name, ownerUid: payment.ownerUid,
    referenceType: 'payment', referenceId: paymentId, paymentId,
    orderId: payment.orderId, orderNumber: payment.orderNumber,
    invoiceId: payment.invoiceId, invoiceNumber: payment.invoiceNumber,
    customerId: payment.customerId || '', customerName: payment.customerSnapshot?.fullName || '',
    detail: { changedFields, reason, amountPaise: payment.amountPaise }, outcome: 'success', at: FieldValue.serverTimestamp(),
  });
}

async function actor(db, tx, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return { uid, role: snap.data().role, name: snap.data().fullName || snap.data().displayName || 'Unknown user' };
}

function invoiceBalance(invoice) {
  if (!validAmount(invoice.totalPaise) || !money(invoice.verifiedPaidPaise) || invoice.verifiedPaidPaise > invoice.totalPaise) fail('Invoice balance is invalid. Contact an administrator.');
  return invoice.totalPaise - invoice.verifiedPaidPaise;
}

async function hasUnverifiedPayment(tx, db, invoiceId, exceptPaymentId = '') {
  const submitted = await tx.get(db.collection('payments').where('invoiceId', '==', invoiceId));
  return submitted.docs.some((entry) => entry.id !== exceptPaymentId && entry.data().verificationStatus === 'unverified');
}

export async function submitPayment(db, uid, input) {
  if (!validId(input?.invoiceId) || !validAmount(input.amountPaise) || !['cash', 'upi', 'bank_transfer'].includes(input.mode)) fail('Choose an invoice, a positive amount and a valid payment mode.');
  const online = input.mode !== 'cash';
  const reference = referenceFor(input.mode, input.transactionNumber);
  if (input.operationId !== undefined && !validId(input.operationId)) fail('Invalid payment request ID.');
  const invoiceRef = db.doc(`invoices/${input.invoiceId}`);
  const paymentRef = input.operationId ? db.doc(`payments/${createHash('sha256').update(`${uid}:${input.operationId}`).digest('hex')}`) : db.collection('payments').doc();
  const referenceRef = online ? referenceDoc(db, reference) : null;
  return db.runTransaction(async (tx) => {
    const identity = await actor(db, tx, uid);
    const prior = await tx.get(paymentRef);
    if (prior.exists) {
      const saved = prior.data();
      if (saved.submittedBy !== uid || saved.invoiceId !== input.invoiceId || saved.amountPaise !== input.amountPaise || saved.mode !== input.mode || saved.transactionNumber !== reference) fail('Payment request ID was already used for different details.');
      return { paymentId: paymentRef.id, alreadySubmitted: true };
    }
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists) fail('Invoice not found.');
    const invoice = invoiceSnap.data();
    if (!staff(identity.role) && invoice.ownerUid !== uid) fail('You may submit payments only for your own invoices.');
    const order = await tx.get(db.doc(`orders/${invoice.orderId}`));
    if (!order.exists || order.data().ownerUid !== invoice.ownerUid) fail('Invoice ownership does not match its order.');
    if (invoice.paymentStatus === 'paid' || invoiceBalance(invoice) === 0) fail('This invoice has no outstanding balance.');
    if (input.amountPaise > invoiceBalance(invoice)) fail('Payment exceeds the current outstanding balance.');
    if (referenceRef && (await tx.get(referenceRef)).exists) fail('This online transaction reference has already been submitted.');
    if (invoice.paymentStatus === 'in_process' || await hasUnverifiedPayment(tx, db, invoiceRef.id)) fail('A payment is already in process for this invoice. Wait for staff review.');
    if (referenceRef) tx.create(referenceRef, { paymentId: paymentRef.id, reference, createdAt: FieldValue.serverTimestamp() });
    const payment = { invoiceId: invoiceRef.id, invoiceNumber: invoice.invoiceNumber, orderId: invoice.orderId, orderNumber: invoice.orderNumber, ownerUid: invoice.ownerUid, customerId: invoice.customerId, customerSnapshot: invoice.customerSnapshot, amountPaise: input.amountPaise, mode: input.mode, transactionNumber: reference, submittedBy: uid, submittedByName: identity.name, submittedAt: FieldValue.serverTimestamp(), verificationStatus: 'unverified', verifiedBy: null, verifiedByName: null, verifiedAt: null, receivedBy: null, reversalId: null };
    tx.create(paymentRef, payment);
    tx.update(invoiceRef, { paymentStatus: 'in_process' });
    paymentEvent(tx, db, 'payment.submitted', identity, paymentRef.id, payment, { amountPaise: { before: null, after: input.amountPaise }, mode: { before: null, after: input.mode }, invoiceStatus: { before: invoice.paymentStatus, after: 'in_process' } });
    orderEvent(tx, db, 'order.payment_submitted', { uid, name: identity.name }, invoice.orderId, order.data(), { paymentId: { before: null, after: paymentRef.id }, amountPaise: { before: null, after: input.amountPaise } });
    return { paymentId: paymentRef.id };
  });
}

export async function reviewPayment(db, uid, input) {
  if (!validId(input?.paymentId) || !['verified', 'rejected'].includes(input.decision) || input.decision === 'rejected' && !text(input.reason, 500)) fail('Payment, decision and rejection reason are required.');
  const paymentRef = db.doc(`payments/${input.paymentId}`);
  return db.runTransaction(async (tx) => {
    const identity = await actor(db, tx, uid);
    if (!staff(identity.role)) fail('Active Admin or Account Admin access is required.');
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists || paymentSnap.data().verificationStatus !== 'unverified') fail('Only an unverified payment can be reviewed.');
    const payment = paymentSnap.data();
    const invoiceRef = db.doc(`invoices/${payment.invoiceId}`);
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists || invoiceSnap.data().orderId !== payment.orderId || invoiceSnap.data().ownerUid !== payment.ownerUid) fail('Payment and invoice do not match.');
    const invoice = invoiceSnap.data();
    if (invoice.paymentStatus === 'paid') fail('Invoice is already paid. Review the payment history.');
    const otherPending = await hasUnverifiedPayment(tx, db, payment.invoiceId, paymentRef.id);
    let next = invoice.verifiedPaidPaise;
    if (input.decision === 'verified') {
      if (!validAmount(payment.amountPaise) || !['cash', 'upi', 'bank_transfer'].includes(payment.mode)) fail('Payment amount or mode is invalid.');
      if (payment.mode === 'cash' && payment.transactionNumber !== '-') fail('Cash transaction number must be -.');
      referenceFor(payment.mode, payment.transactionNumber);
      if (payment.amountPaise > invoiceBalance(invoice)) fail('Payment exceeds the current balance.');
      next += payment.amountPaise;
    }
    const nextStatus = otherPending ? 'in_process' : next === invoice.totalPaise ? 'paid' : next > 0 ? 'partial' : 'unpaid';
    tx.update(invoiceRef, { verifiedPaidPaise: next, paymentStatus: nextStatus, ...(nextStatus === 'paid' ? { paidBy: uid, paidAt: FieldValue.serverTimestamp() } : {}) });
    tx.update(paymentRef, { verificationStatus: input.decision, verifiedBy: uid, verifiedByName: identity.name, verifiedAt: FieldValue.serverTimestamp(), receivedBy: input.decision === 'verified' ? uid : null, reviewReason: input.decision === 'rejected' ? input.reason.trim() : null });
    paymentEvent(tx, db, `payment.${input.decision}`, identity, paymentRef.id, payment, { verificationStatus: { before: 'unverified', after: input.decision }, invoiceStatus: { before: invoice.paymentStatus, after: nextStatus }, verifiedPaidPaise: { before: invoice.verifiedPaidPaise, after: next } }, input.decision === 'rejected' ? input.reason.trim() : '');
    if (nextStatus === 'paid') audit(tx, db, 'invoice.marked_paid', uid, 'invoice', invoiceRef.id, { verifiedPaidPaise: next, totalPaise: invoice.totalPaise }, identity.name);
    return { paymentId: paymentRef.id, verificationStatus: input.decision };
  });
}

export async function changePaymentMode(db, uid, input) {
  if (!validId(input?.paymentId) || !['cash', 'upi', 'bank_transfer'].includes(input.mode) || !text(input.reason, 500)) fail('Payment, new mode and correction reason are required.');
  const reference = referenceFor(input.mode, input.transactionNumber);
  const paymentRef = db.doc(`payments/${input.paymentId}`);
  return db.runTransaction(async (tx) => {
    const identity = await actor(db, tx, uid);
    if (!staff(identity.role)) fail('Active Admin or Account Admin access is required.');
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists || paymentSnap.data().verificationStatus !== 'unverified') fail('Only an unverified payment may be corrected. Use an explicit reversal for verified funds.');
    const payment = paymentSnap.data();
    const invoiceSnap = await tx.get(db.doc(`invoices/${payment.invoiceId}`));
    if (!invoiceSnap.exists || invoiceSnap.data().orderId !== payment.orderId || invoiceSnap.data().ownerUid !== payment.ownerUid || invoiceSnap.data().paymentStatus === 'paid') fail('Payment and invoice cannot be reconciled.');
    if (payment.mode === input.mode && payment.transactionNumber === reference) fail('Payment mode and reference are unchanged.');
    const referenceRef = input.mode === 'cash' || reference === payment.transactionNumber ? null : referenceDoc(db, reference);
    const reservation = referenceRef ? await tx.get(referenceRef) : null;
    if (reservation?.exists && reservation.data().paymentId !== paymentRef.id) fail('This online transaction reference has already been submitted.');
    if (referenceRef && !reservation.exists) tx.create(referenceRef, { paymentId: paymentRef.id, reference, createdAt: FieldValue.serverTimestamp() });
    tx.update(paymentRef, { mode: input.mode, transactionNumber: reference, correctedAt: FieldValue.serverTimestamp(), correctedBy: uid });
    paymentEvent(tx, db, 'payment.mode_changed', identity, paymentRef.id, payment, {
      mode: { before: payment.mode, after: input.mode },
      transactionNumber: { before: payment.transactionNumber, after: reference },
    }, input.reason.trim());
    return { paymentId: paymentRef.id, mode: input.mode };
  });
}

export async function reversePayment(db, uid, input) {
  if (!validId(input?.paymentId) || !text(input.reason, 500)) fail('Payment and reversal reason are required.');
  const paymentRef = db.doc(`payments/${input.paymentId}`);
  const reversalRef = db.doc(`paymentReversals/${input.paymentId}`);
  return db.runTransaction(async (tx) => {
    const identity = await actor(db, tx, uid);
    if (!staff(identity.role)) fail('Active Admin or Account Admin access is required.');
    const paymentSnap = await tx.get(paymentRef);
    const reversal = await tx.get(reversalRef);
    if (!paymentSnap.exists || paymentSnap.data().verificationStatus !== 'verified' || reversal.exists || paymentSnap.data().reversalId) fail('Only an unreversed verified payment can be reversed.');
    const payment = paymentSnap.data();
    const invoiceRef = db.doc(`invoices/${payment.invoiceId}`);
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists || invoiceSnap.data().orderId !== payment.orderId || invoiceSnap.data().ownerUid !== payment.ownerUid || invoiceSnap.data().verifiedPaidPaise < payment.amountPaise) fail('Invoice balance cannot be reconciled.');
    const invoice = invoiceSnap.data();
    const next = invoice.verifiedPaidPaise - payment.amountPaise;
    const nextStatus = await hasUnverifiedPayment(tx, db, payment.invoiceId) ? 'in_process' : next === 0 ? 'unpaid' : 'partial';
    tx.create(reversalRef, { paymentId: paymentRef.id, invoiceId: payment.invoiceId, amountPaise: payment.amountPaise, reason: input.reason.trim(), actorUid: uid, at: FieldValue.serverTimestamp() });
    tx.update(paymentRef, { reversalId: reversalRef.id });
    tx.update(invoiceRef, { verifiedPaidPaise: next, paymentStatus: nextStatus, ...(invoice.paymentStatus === 'paid' ? { paidReversedAt: FieldValue.serverTimestamp(), paidReversedBy: uid } : {}) });
    paymentEvent(tx, db, 'payment.reversed', identity, paymentRef.id, payment, { reversalId: { before: null, after: reversalRef.id }, invoiceStatus: { before: invoice.paymentStatus, after: nextStatus } }, input.reason.trim());
    return { paymentId: paymentRef.id, reversalId: reversalRef.id };
  });
}

export async function markInvoicePaid(db, uid, input) {
  if (!validId(input?.invoiceId)) fail('Invoice ID is required.');
  const invoiceRef = db.doc(`invoices/${input.invoiceId}`);
  return db.runTransaction(async (tx) => {
    const identity = await actor(db, tx, uid);
    if (identity.role !== 'account_admin') fail('Account Admin access is required.');
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
      if (payment.verificationStatus === 'unverified') fail('A payment is still in process for this invoice.');
      if (payment.verificationStatus === 'verified' && !payment.reversalId) verified += payment.amountPaise;
    }
    if (!Number.isSafeInteger(verified) || verified !== invoice.verifiedPaidPaise || verified !== invoice.totalPaise) fail('Verified payments do not reconcile with the invoice total.');
    tx.update(invoiceRef, { paymentStatus: 'paid', paidBy: uid, paidAt: FieldValue.serverTimestamp() });
    audit(tx, db, 'invoice.marked_paid', uid, 'invoice', invoiceRef.id, { verifiedPaidPaise: verified, totalPaise: invoice.totalPaise }, identity.name);
    return { invoiceId: invoiceRef.id, paymentStatus: 'paid' };
  });
}
