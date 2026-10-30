import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export const MAX_QTY = 1_000_000_000; // milli-units; 1000 = one displayed unit
export const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
export class OperationError extends Error {}
export const fail = (message) => { throw new OperationError(message); };
export const qty = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= MAX_QTY;
export const money = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_000;
export const validId = (value) => text(value, 128) && !value.includes('/') && value !== '.' && value !== '..';
export const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateDriveUrl(value) {
  if (value === '') return '';
  if (!text(value, 500)) fail('Enter a valid Google Drive document URL.');
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid Google Drive document URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port || !/^\/file\/d\/[A-Za-z0-9_-]{10,}\/view\/?$/.test(url.pathname)) fail('Use a Google Drive file view link.');
  return `https://drive.google.com${url.pathname}`;
}

export function validateDraft(input) {
  if (!text(input?.supplierName, 120) || !validDate(input.purchaseDate) || !validId(input.purchaseTypeId)) fail('Supplier, valid date and purchase type are required.');
  if (typeof input.notes !== 'string' || input.notes.length > 1000) fail('Notes must be 1000 characters or fewer.');
  if (!money(input.totalPaise) || !money(input.paidAmountPaise ?? 0) || (input.paidAmountPaise ?? 0) > input.totalPaise) fail('Enter a nonnegative total and a payment amount no greater than the total.');
  if (Object.hasOwn(input, 'lines')) fail('Purchase item lines are no longer supported. Reload the updated form.');
  const quantity = typeof input.quantity === 'number' && Number.isFinite(input.quantity) ? String(input.quantity) : input.quantity;
  if (!text(quantity, 120)) fail('Enter a quantity of 120 characters or fewer.');
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(quantity.trim()) && Number(quantity.trim()) <= 0) fail('Quantity must be greater than zero.');
  if (input.unit !== undefined && (typeof input.unit !== 'string' || input.unit.length > 80)) fail('Unit must be 80 characters or fewer.');
  const paidAmountPaise = input.paidAmountPaise ?? 0;
  const paymentMode = paidAmountPaise ? input.paymentMode : null;
  if (paidAmountPaise && !['cash', 'upi', 'bank_transfer'].includes(paymentMode)) fail('Choose a valid payment mode.');
  const paymentReference = paidAmountPaise && paymentMode !== 'cash' ? input.paymentReference : '-';
  if (!text(paymentReference, 100)) fail('Online payments require a transaction reference.');
  return { quantity: quantity.trim(), unit: (input.unit || '').trim(), supplierName: input.supplierName.trim(), purchaseDate: input.purchaseDate, purchaseTypeId: input.purchaseTypeId, totalPaise: input.totalPaise, paidAmountPaise, paymentMode, paymentReference: paymentReference.trim(), paymentStatus: paidAmountPaise === 0 ? 'unpaid' : paidAmountPaise === input.totalPaise ? 'paid' : 'partial', notes: input.notes.trim(), documentUrl: validateDriveUrl(input.documentUrl || ''), schemaVersion: 3 };
}

async function staff(db, uid, tx, permission = 'operatePurchases') {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin'].includes(snap.data().role)) fail('Active Admin or Account Admin access is required.');
  return { uid, name: snap.data().fullName || snap.data().displayName || 'Unknown user' };
}

export function audit(tx, db, type, uid, refType, refId, detail = {}, actorName = null) {
  tx.create(db.collection('auditLogs').doc(), { type, actorUid: uid, ...(actorName ? { actorName } : {}), referenceType: refType, referenceId: refId, detail, at: FieldValue.serverTimestamp() });
}

export function stockState(snap) {
  const data = snap.exists ? snap.data() : {};
  if (snap.exists && (!Object.hasOwn(data, 'onHandQty') || !Object.hasOwn(data, 'reservedQty'))) fail('Inventory record needs reviewed migration before use.');
  const onHandQty = data.onHandQty ?? 0;
  const reservedQty = data.reservedQty ?? 0;
  if (!qty(onHandQty) || reservedQty !== 0) fail('Inventory data is invalid or uses an unsupported reservation workflow.');
  const lowStockThresholdQty = data.lowStockThresholdQty ?? 0;
  if (!qty(lowStockThresholdQty)) fail('Inventory threshold is invalid.');
  return { onHandQty, reservedQty, sellingBlocked: data.sellingBlocked === true, lowStockThresholdQty };
}

export function setStock(tx, ref, state, newQty, uid, extra = {}) {
  if (!qty(newQty)) fail('Insufficient stock or stock limit exceeded.');
  tx.set(ref, { itemId: ref.id, ...state, ...extra, onHandQty: newQty, reservedQty: 0, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export function movement(tx, db, id, itemId, item, type, changeQty, previousQty, referenceType, referenceId, reason, uid, ownerUid = null, actorName = 'Unknown user') {
  tx.create(db.doc(`inventoryMovements/${id}`), {
    itemId, itemSnapshot: { itemCode: item.itemCode, name: item.name, unitId: item.defaultUnitId, unitSymbol: item.unitSymbol },
    movementType: type, changeQty, previousQty, newQty: previousQty + changeQty,
    referenceType, referenceId, reason, actorUid: uid, actorName, ownerUid, at: FieldValue.serverTimestamp(),
  });
}

export async function savePurchaseDraft(db, uid, input) {
  const values = validateDraft(input);
  const purchaseId = input.purchaseId || db.collection('purchases').doc().id;
  if (!validId(purchaseId)) fail('Invalid purchase ID.');
  const ref = db.doc(`purchases/${purchaseId}`);
  return db.runTransaction(async (tx) => {
    await staff(db, uid, tx);
    const existing = await tx.get(ref);
    const type = await tx.get(db.doc(`purchaseTypes/${values.purchaseTypeId}`));
    if (existing.exists && existing.data().status !== 'draft') fail('Only draft purchases can be edited.');
    if (!type.exists || type.data().active !== true) fail('Choose an active purchase type.');
    if (input.attachment != null) values.attachment = await checkedPurchaseAttachment(uid, purchaseId, input.attachment);
    tx.set(ref, { ...values, purchaseTypeSnapshot: type.data().name, status: 'draft', createdBy: existing.exists ? existing.data().createdBy : uid, createdAt: existing.exists ? existing.data().createdAt : FieldValue.serverTimestamp(), updatedBy: uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    audit(tx, db, existing.exists ? 'purchase.draft_updated' : 'purchase.draft_created', uid, 'purchase', purchaseId, { totalPaise: values.totalPaise, previousTotalPaise: existing.exists ? existing.data().totalPaise : null, paidAmountPaise: values.paidAmountPaise, paymentStatus: values.paymentStatus });
    return { purchaseId };
  });
}

const purchaseBucket = () => getStorage().bucket(process.env.PAYMENT_RECEIPTS_BUCKET || `${process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT}.firebasestorage.app`);

export function validatePurchaseAttachment(bytes, metadata, uid, purchaseId, extension) {
  const size = Number(metadata.size), mime = metadata.contentType;
  if (!Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 * 1024) fail('Purchase attachment must be nonempty and at most 5 MB.');
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
  const signature = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
    : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : false;
  const originalName = metadata.metadata?.originalName;
  if (!signature || !types[mime] || types[mime] !== extension || bytes.length !== size || !text(originalName, 150)
    || !new RegExp(`\\.${extension === 'jpg' ? 'jpe?g' : extension}$`, 'i').test(originalName)) fail('Choose a valid JPG, JPEG, PNG or PDF purchase attachment.');
  if (metadata.metadata?.ownerUid !== uid || metadata.metadata?.purchaseId !== purchaseId) fail('Attachment does not belong to this purchase.');
  return { name: originalName, size, contentType: mime };
}

async function checkedPurchaseAttachment(uid, purchaseId, attachment) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachment?.uploadId || '') || !['jpg', 'png', 'pdf'].includes(attachment?.extension)) fail('Choose a valid JPG, JPEG, PNG or PDF purchase attachment.');
  const path = `purchaseReceipts/${uid}/${purchaseId}/${attachment.uploadId}.${attachment.extension}`;
  try {
    const file = purchaseBucket().file(path), [metadata] = await file.getMetadata();
    if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 1 || Number(metadata.size) > 5 * 1024 * 1024) fail('Purchase attachment must be nonempty and at most 5 MB.');
    const [bytes] = await file.download();
    return { path, ...validatePurchaseAttachment(bytes, metadata, uid, purchaseId, attachment.extension) };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    fail('Purchase attachment upload is missing or unavailable. Please retry.');
  }
}

export async function readPurchaseReceipt(db, uid, input) {
  if (!validId(input?.purchaseId)) fail('Invalid purchase.');
  await staff(db, uid, { get: (ref) => ref.get() });
  const snap = await db.doc(`purchases/${input.purchaseId}`).get();
  const attachment = snap.exists && snap.data().attachment;
  if (!attachment?.path || !/^purchaseReceipts\/[^/]+\/[^/]+\/[A-Za-z0-9_-]+\.(jpg|png|pdf)$/.test(attachment.path) || attachment.path.split('/')[2] !== input.purchaseId) fail('No attachment is available for this purchase.');
  const file = purchaseBucket().file(attachment.path), [metadata] = await file.getMetadata();
  if (Number(metadata.size) < 1 || Number(metadata.size) > 5 * 1024 * 1024) fail('Invalid purchase attachment size.');
  const [bytes] = await file.download();
  return { name: attachment.name, contentType: attachment.contentType, base64: bytes.toString('base64') };
}

export async function confirmPurchase(db, uid, purchaseId) {
  if (!validId(purchaseId)) fail('Invalid purchase ID.');
  const ref = db.doc(`purchases/${purchaseId}`);
  return db.runTransaction(async (tx) => {
    await staff(db, uid, tx);
    const purchase = await tx.get(ref);
    if (!purchase.exists || purchase.data().status !== 'draft') fail('Only a draft purchase can be confirmed.');
    const total = purchase.data().totalPaise;
    if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000_000_000) fail('Purchase total is invalid. Review the draft.');
    tx.update(ref, { status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), confirmedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    audit(tx, db, 'purchase.confirmed', uid, 'purchase', purchaseId, { totalPaise: purchase.data().totalPaise });
    return { purchaseId, status: 'confirmed' };
  });
}

export async function cancelPurchase(db, uid, purchaseId, reason) {
  if (!validId(purchaseId) || !text(reason, 500)) fail('Purchase and cancellation reason are required.');
  const ref = db.doc(`purchases/${purchaseId}`);
  return db.runTransaction(async (tx) => {
    await staff(db, uid, tx);
    const purchase = await tx.get(ref);
    if (!purchase.exists || !['draft', 'confirmed'].includes(purchase.data().status)) fail('This purchase cannot be cancelled.');
    const confirmed = purchase.data().status === 'confirmed';
    tx.update(ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), cancelledBy: uid, cancellationReason: reason.trim(), updatedAt: FieldValue.serverTimestamp() });
    audit(tx, db, confirmed ? 'purchase.cancelled' : 'purchase.draft_cancelled', uid, 'purchase', purchaseId, { reason: reason.trim() });
    return { purchaseId, status: 'cancelled' };
  });
}

export async function adjustStock(db, uid, input) {
  const { itemId, countedQty, reason, operationId, expectedOnHandQty } = input || {};
  if (!validId(itemId) || !qty(countedQty) || !text(reason, 500) || !validId(operationId) || expectedOnHandQty !== undefined && !qty(expectedOnHandQty)) fail('Item, counted quantity, reason and operation ID are required.');
  const op = db.doc(`stockOperations/${operationId}`);
  return db.runTransaction(async (tx) => {
    const user = await staff(db, uid, tx, 'manageStock');
    const priorOp = await tx.get(op);
    if (priorOp.exists) {
      if (priorOp.data().actorUid !== uid || priorOp.data().itemId !== itemId || priorOp.data().countedQty !== countedQty || priorOp.data().reason !== reason.trim() || priorOp.data().expectedOnHandQty !== expectedOnHandQty) fail('Operation ID was already used.');
      return { itemId, newQty: countedQty, repeated: true };
    }
    const item = await tx.get(db.doc(`items/${itemId}`));
    const stock = await tx.get(db.doc(`inventory/${itemId}`));
    if (!item.exists) fail('Item no longer exists.');
    const unit = await tx.get(db.doc(`units/${item.data().defaultUnitId}`));
    if (!unit.exists) fail('Item unit no longer exists.');
    const state = stockState(stock);
    if (expectedOnHandQty !== undefined && state.onHandQty !== expectedOnHandQty) fail('Stock changed since this count was opened. Refresh and count again.');
    const change = countedQty - state.onHandQty;
    if (!change) fail('Counted quantity matches current stock.');
    setStock(tx, stock.ref, state, countedQty, uid);
    movement(tx, db, `adjustment_${operationId}`, itemId, { ...item.data(), unitSymbol: unit.data().symbol }, 'physical_adjustment', change, state.onHandQty, 'stockOperation', operationId, reason.trim(), uid, null, user.name);
    tx.create(op, { actorUid: uid, itemId, countedQty, ...(expectedOnHandQty !== undefined ? { expectedOnHandQty } : {}), reason: reason.trim(), at: FieldValue.serverTimestamp() });
    audit(tx, db, 'inventory.adjusted', uid, 'stockOperation', operationId, { itemId, previousQty: state.onHandQty, newQty: countedQty, changeQty: change, reason: reason.trim() }, user.name);
    return { itemId, newQty: countedQty, repeated: false };
  });
}

export async function setInventoryControl(db, uid, input) {
  const { itemId, sellingBlocked, lowStockThresholdQty, reason, expectedSellingBlocked, expectedLowStockThresholdQty } = input || {};
  if (!validId(itemId) || typeof sellingBlocked !== 'boolean' || !qty(lowStockThresholdQty) || !text(reason, 500) || expectedSellingBlocked !== undefined && typeof expectedSellingBlocked !== 'boolean' || expectedLowStockThresholdQty !== undefined && !qty(expectedLowStockThresholdQty)) fail('Item, selling status, threshold and reason are required.');
  const ref = db.doc(`inventory/${itemId}`);
  return db.runTransaction(async (tx) => {
    const user = await staff(db, uid, tx, 'manageStock');
    const item = await tx.get(db.doc(`items/${itemId}`));
    const stock = await tx.get(ref);
    if (!item.exists) fail('Item no longer exists.');
    const state = stockState(stock);
    if (expectedSellingBlocked !== undefined && state.sellingBlocked !== expectedSellingBlocked || expectedLowStockThresholdQty !== undefined && state.lowStockThresholdQty !== expectedLowStockThresholdQty) fail('Stock controls changed since this dialog was opened. Refresh and try again.');
    if (state.sellingBlocked === sellingBlocked && state.lowStockThresholdQty === lowStockThresholdQty) fail('No stock control change was made.');
    setStock(tx, ref, state, state.onHandQty, uid, { sellingBlocked, lowStockThresholdQty });
    audit(tx, db, 'inventory.control_changed', uid, 'item', itemId, { previousSellingBlocked: state.sellingBlocked, sellingBlocked, previousLowStockThresholdQty: state.lowStockThresholdQty, lowStockThresholdQty, reason: reason.trim() }, user.name);
    return { itemId, sellingBlocked, lowStockThresholdQty };
  });
}
