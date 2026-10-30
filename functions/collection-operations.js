import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { OperationError, fail, validId, money, text } from './operations.js';

const staff = (role) => ['admin', 'account_admin'].includes(role);
const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const bucket = () => getStorage().bucket(process.env.PAYMENT_RECEIPTS_BUCKET || `${process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT}.firebasestorage.app`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const collectionDay = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const positive = (value) => money(value) && value > 0;
const refNumber = (mode, value) => {
  if (mode === 'cash') return '-';
  const result = String(value || '').trim().toUpperCase();
  if (!text(result, 100) || !/^[A-Z0-9][A-Z0-9/_-]*$/.test(result)) fail('UPI and online entries require a valid transaction ID.');
  return result;
};
async function identity(db, tx, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return { uid, role: snap.data().role, name: snap.data().fullName || snap.data().displayName || 'Unknown user' };
}
async function receipt(uid, operationId, index, attachment) {
  if (!attachment) return null;
  if (!['jpg', 'png', 'pdf'].includes(attachment.extension)) fail('Receipt format is unsupported. Choose JPG, JPEG, PNG or PDF.');
  const path = `collectionReceipts/${uid}/${operationId}/${index}.${attachment.extension}`;
  let metadata, bytes;
  try {
    const file = bucket().file(path);
    [metadata] = await file.getMetadata();
    if (!positive(Number(metadata.size)) || Number(metadata.size) > 5 * 1024 * 1024) fail('Receipt must be at most 5 MB.');
    [bytes] = await file.download();
  } catch (error) { if (error instanceof OperationError) throw error; fail('Collection receipt upload is missing. Retry the upload.'); }
  const mime = metadata.contentType, size = Number(metadata.size);
  const signature = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
    : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : false;
  if (!signature || types[mime] !== attachment.extension || bytes.length !== size || metadata.metadata?.ownerUid !== uid || metadata.metadata?.operationId !== operationId) fail('Receipt must be a valid JPG, PNG or PDF for this collection.');
  return { path, name: String(metadata.metadata?.originalName || 'Receipt').slice(0, 150), size, contentType: mime };
}
function event(tx, db, collection, id, actor, type, reason = '') {
  tx.create(db.collection('auditLogs').doc(), { type, actorUid: actor.uid, actorName: actor.name, ownerUid: collection.ownerUid, referenceType: 'collection', referenceId: id, collectionId: id, detail: { totalPaise: collection.totalPaise, reason }, outcome: 'success', at: FieldValue.serverTimestamp() });
}
export async function submitCollection(db, uid, input) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input?.operationId || '') || !Array.isArray(input.allocations) || !Array.isArray(input.entries) || !input.allocations.length || input.allocations.length > 40 || !input.entries.length || input.entries.length > 20 || typeof input.remarks !== 'string' || input.remarks.length > 1000) fail('Collection details are invalid.');
  const seen = new Set(), totals = input.entries.map(() => 0);
  for (const row of input.allocations) {
    if (!validId(row?.invoiceId) || seen.has(row.invoiceId) || !positive(row.amountPaise) || !Number.isInteger(row.paymentIndex) || row.paymentIndex < 0 || row.paymentIndex >= input.entries.length) fail('Collection invoice allocations must be unique, positive and linked to a payment entry.');
    seen.add(row.invoiceId); totals[row.paymentIndex] += row.amountPaise;
  }
  if (totals.some((amount) => !positive(amount))) fail('Each payment entry must have at least one invoice allocation.');
  const entries = [];
  for (let index = 0; index < input.entries.length; index++) {
    const item = input.entries[index];
    if (!['cash', 'upi', 'bank_transfer'].includes(item?.mode)) fail('Choose Cash, UPI or Online for every payment entry.');
    if (item.mode !== 'cash' && !item.attachment) fail('UPI and online entries require a receipt.');
    entries.push({ mode: item.mode, transactionNumber: refNumber(item.mode, item.transactionNumber), attachment: await receipt(uid, input.operationId, index, item.attachment), amountPaise: totals[index] });
  }
  const totalPaise = totals.reduce((sum, value) => sum + value, 0);
  if (!positive(totalPaise)) fail('Collection total is invalid.');
  const id = hash(`${uid}:${input.operationId}`);
  const requestHash = hash(JSON.stringify({ allocations: input.allocations, entries: entries.map((entry) => ({ mode: entry.mode, transactionNumber: entry.transactionNumber, attachmentPath: entry.attachment?.path || null })), remarks: input.remarks.trim() }));
  return db.runTransaction(async (tx) => {
    const actor = await identity(db, tx, uid), ref = db.doc(`collections/${id}`);
    const prior = await tx.get(ref);
    if (prior.exists) {
      if (prior.data().submittedBy !== uid || prior.data().operationId !== input.operationId || prior.data().requestHash !== requestHash) fail('Collection request ID was already used for different details.');
      return { collectionId: id, collectionNumber: prior.data().collectionNumber, alreadySubmitted: true };
    }
    const invoiceRefs = input.allocations.map((row) => db.doc(`invoices/${row.invoiceId}`));
    const invoiceSnaps = await tx.getAll(...invoiceRefs);
    const customers = new Map(), allocations = [];
    for (let index = 0; index < input.allocations.length; index++) {
      const row = input.allocations[index], snap = invoiceSnaps[index], invoice = snap.data();
      if (!snap.exists || !validId(invoice.customerId) || !validId(invoice.orderId)) fail('Collection invoice was not found.');
      if (!staff(actor.role) && invoice.ownerUid !== uid) fail('Collection invoice access is required.');
      if (!positive(invoice.totalPaise) || !money(invoice.verifiedPaidPaise) || invoice.verifiedPaidPaise > invoice.totalPaise || row.amountPaise > invoice.totalPaise - invoice.verifiedPaidPaise || invoice.paymentStatus === 'paid') fail('Collection amount exceeds the current invoice balance.');
      if (invoice.paymentStatus === 'in_process') fail('An invoice already has a payment awaiting review.');
      allocations.push({ invoiceId: snap.id, invoiceNumber: invoice.invoiceNumber, orderId: invoice.orderId, orderNumber: invoice.orderNumber, ownerUid: invoice.ownerUid, customerId: invoice.customerId, customerName: invoice.customerSnapshot?.fullName || '', amountPaise: row.amountPaise, paymentIndex: row.paymentIndex, balanceAtSubmissionPaise: invoice.totalPaise - invoice.verifiedPaidPaise });
      customers.set(invoice.customerId, invoice.customerSnapshot?.fullName || '');
    }
    if (!staff(actor.role)) {
      const customerSnaps = await tx.getAll(...[...customers.keys()].map((id) => db.doc(`customers/${id}`)));
      for (const snap of customerSnaps) if (!snap.exists || (snap.data().assignedUserId !== uid && !(snap.data().ownerUserIds || []).includes(uid))) fail('Collection customer access is required.');
    }
    const referenceRefs = entries.map((entry) => entry.mode === 'cash' ? null : db.doc(`paymentReferences/${hash(entry.transactionNumber)}`));
    const onlineRefs = referenceRefs.filter(Boolean), onlineSnaps = onlineRefs.length ? await tx.getAll(...onlineRefs) : [];
    if (new Set(onlineRefs.map((item) => item.path)).size !== onlineRefs.length || onlineSnaps.some((snap) => snap.exists)) fail('An online transaction ID has already been used.');
    const collection = { operationId: input.operationId, requestHash, collectionNumber: `COL-${collectionDay().replaceAll('-', '')}-${input.operationId.replaceAll('-', '').toUpperCase()}`, ownerUid: uid, submittedBy: uid, submittedByName: actor.name, submittedAt: FieldValue.serverTimestamp(), collectionDate: collectionDay(), status: 'pending', allocations, entries, customerCount: customers.size, invoiceCount: allocations.length, totalPaise, approvedPaise: 0, remarks: input.remarks.trim(), verifiedBy: null, verifiedByName: null, verifiedAt: null, rejectionReason: null };
    tx.create(ref, collection);
    for (let index = 0; index < referenceRefs.length; index++) if (referenceRefs[index]) tx.create(referenceRefs[index], { collectionId: id, entryIndex: index, reference: entries[index].transactionNumber, createdAt: FieldValue.serverTimestamp() });
    event(tx, db, collection, id, actor, 'collection.submitted');
    return { collectionId: id, collectionNumber: collection.collectionNumber };
  });
}
export async function reviewCollection(db, uid, input) {
  if (!validId(input?.collectionId) || !['verified', 'rejected'].includes(input.decision) || (input.decision === 'rejected' && !text(input.reason, 500))) fail('Collection, decision and rejection reason are required.');
  return db.runTransaction(async (tx) => {
    const actor = await identity(db, tx, uid);
    if (!staff(actor.role)) fail('Admin or Account Admin access is required.');
    const ref = db.doc(`collections/${input.collectionId}`), snap = await tx.get(ref);
    if (!snap.exists) fail('Collection not found.');
    if (snap.data().status !== 'pending') {
      if (snap.data().status === input.decision) return { collectionId: ref.id, status: input.decision, approvedPaise: snap.data().approvedPaise, alreadyReviewed: true };
      fail('Only a pending collection can be reviewed.');
    }
    const collection = snap.data(), rows = collection.allocations;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40 || new Set(rows.map((row) => row.invoiceId)).size !== rows.length || rows.reduce((sum, row) => sum + row.amountPaise, 0) !== collection.totalPaise || collection.entries.reduce((sum, entry) => sum + entry.amountPaise, 0) !== collection.totalPaise) fail('Collection totals do not reconcile.');
    const invoiceRefs = rows.map((row) => db.doc(`invoices/${row.invoiceId}`));
    const invoices = input.decision === 'verified' ? await tx.getAll(...invoiceRefs) : [];
    const paymentRefs = rows.map((_, index) => db.doc(`payments/${input.collectionId}_${index}`));
    const payments = input.decision === 'verified' ? await tx.getAll(...paymentRefs) : [];
    const reservedRefs = input.decision === 'rejected' ? collection.entries.filter((entry) => entry.mode !== 'cash').map((entry) => db.doc(`paymentReferences/${hash(entry.transactionNumber)}`)) : [];
    const reservations = reservedRefs.length ? await tx.getAll(...reservedRefs) : [];
    if (payments.some((payment) => payment.exists)) fail('Collection payments already exist.');
    let approved = 0;
    if (input.decision === 'verified') for (let index = 0; index < rows.length; index++) {
      const row = rows[index], snap = invoices[index], invoice = snap.data(), entry = collection.entries[row.paymentIndex];
      if (!snap.exists || !entry || !positive(row.amountPaise) || invoice.ownerUid !== row.ownerUid || invoice.customerId !== row.customerId || invoice.orderId !== row.orderId || !positive(invoice.totalPaise) || !money(invoice.verifiedPaidPaise) || invoice.paymentStatus === 'in_process' || row.amountPaise > invoice.totalPaise - invoice.verifiedPaidPaise) fail('Invoice balance changed; collection cannot be approved.');
      const next = invoice.verifiedPaidPaise + row.amountPaise, status = next === invoice.totalPaise ? 'paid' : 'partial';
      tx.update(invoiceRefs[index], { verifiedPaidPaise: next, paymentStatus: status, ...(status === 'paid' ? { paidBy: uid, paidAt: FieldValue.serverTimestamp() } : {}) });
      tx.create(paymentRefs[index], { collectionId: ref.id, collectionNumber: collection.collectionNumber, collectionEntryIndex: row.paymentIndex, invoiceId: row.invoiceId, invoiceNumber: row.invoiceNumber, orderId: row.orderId, orderNumber: row.orderNumber, ownerUid: row.ownerUid, customerId: row.customerId, customerSnapshot: { fullName: row.customerName }, amountPaise: row.amountPaise, mode: entry.mode, transactionNumber: entry.transactionNumber, attachment: entry.attachment, submittedBy: collection.submittedBy, submittedByName: collection.submittedByName, submittedAt: collection.submittedAt, verificationStatus: 'verified', verifiedBy: uid, verifiedByName: actor.name, verifiedAt: FieldValue.serverTimestamp(), receivedBy: uid, reversalId: null });
      tx.create(db.collection('auditLogs').doc(), { type: 'payment.verified', actorUid: uid, actorName: actor.name, ownerUid: row.ownerUid, referenceType: 'payment', referenceId: paymentRefs[index].id, paymentId: paymentRefs[index].id, collectionId: ref.id, invoiceId: row.invoiceId, invoiceNumber: row.invoiceNumber, orderId: row.orderId, orderNumber: row.orderNumber, customerId: row.customerId, customerName: row.customerName, detail: { amountPaise: row.amountPaise, mode: entry.mode, transactionNumber: entry.transactionNumber, collectionNumber: collection.collectionNumber }, outcome: 'success', at: FieldValue.serverTimestamp() });
      approved += row.amountPaise;
    }
    if (input.decision === 'verified' && approved !== collection.totalPaise) fail('Approved allocations do not reconcile.');
    if (input.decision === 'rejected') for (let index = 0; index < reservedRefs.length; index++) if (reservations[index].exists && reservations[index].data().collectionId === ref.id) tx.delete(reservedRefs[index]);
    tx.update(ref, { status: input.decision, approvedPaise: approved, verifiedBy: uid, verifiedByName: actor.name, verifiedAt: FieldValue.serverTimestamp(), rejectionReason: input.decision === 'rejected' ? input.reason.trim() : null });
    event(tx, db, collection, ref.id, actor, `collection.${input.decision}`, input.decision === 'rejected' ? input.reason.trim() : '');
    return { collectionId: ref.id, status: input.decision, approvedPaise: approved };
  });
}
export async function readCollectionReceipt(db, uid, input) {
  if (!validId(input?.collectionId) || !Number.isInteger(input.entryIndex)) fail('Invalid collection receipt.');
  const [profile, snap] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`collections/${input.collectionId}`).get()]);
  if (!profile.exists || profile.data().active !== true || !['admin', 'account_admin', 'user'].includes(profile.data().role) || !snap.exists || (!staff(profile.data().role) && snap.data().ownerUid !== uid)) fail('Collection receipt access is required.');
  const attachment = snap.data().entries?.[input.entryIndex]?.attachment;
  if (!attachment?.path || !attachment.path.startsWith(`collectionReceipts/${snap.data().ownerUid}/`)) fail('No receipt is attached to this payment entry.');
  const [bytes] = await bucket().file(attachment.path).download();
  return { name: attachment.name, contentType: attachment.contentType, base64: bytes.toString('base64') };
}
