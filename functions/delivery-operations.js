import { FieldValue } from 'firebase-admin/firestore';
import { OperationError } from './operations.js';

const fail = (message) => { throw new OperationError(message); };
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);

export async function createDelivery(db, uid, input) {
  if (!validId(input?.orderId) || !validId(input?.submissionId)) fail('Invalid order or delivery request.');
  if (!Array.isArray(input.lines) || !input.lines.length) fail('Enter delivered quantities.');
  if (typeof input.remarks !== 'string' || input.remarks.length > 1000) fail('Remarks are too long.');
  const deliveryRef = db.doc(`deliveries/${input.submissionId}`);
  const orderRef = db.doc(`orders/${input.orderId}`);
  return db.runTransaction(async (tx) => {
    const [actor, orderSnap, existing, history] = await Promise.all([
      tx.get(db.doc(`users/${uid}`)), tx.get(orderRef), tx.get(deliveryRef),
      tx.get(db.collection('deliveries').where('orderId', '==', input.orderId)),
    ]);
    if (!actor.exists || actor.data().active !== true || !['admin', 'account_admin', 'user'].includes(actor.data().role)) fail('Active OMS access is required.');
    if (!orderSnap.exists) fail('Order does not exist.');
    const order = orderSnap.data();
    if (!['admin', 'account_admin'].includes(actor.data().role) && order.assignedUserId !== uid && order.ownerUid !== uid) fail('Access denied: this order is not assigned to you.');
    const assignee = await tx.get(db.doc(`users/${order.assignedUserId || order.ownerUid}`));
    if (existing.exists) {
      if (existing.data().orderId !== input.orderId || existing.data().deliveredBy !== uid) fail('Delivery request ID is already used.');
      return { deliveryId: deliveryRef.id, deliveryNumber: existing.data().deliveryNumber, duplicate: true };
    }
    if (!['confirmed', 'in_preparation', 'ready', 'invoiced'].includes(order.status) || order.archivedAt) fail('Only an active confirmed or invoiced order can be delivered.');
    const ordered = order.lines || [];
    if (input.lines.length !== ordered.length || !ordered.length) fail('Delivery lines do not match the order.');
    const previous = ordered.map((_, index) => history.docs.reduce((total, doc) => total + (doc.data().lines?.[index]?.deliveredQty || 0), 0));
    const lines = ordered.map((line, index) => {
      const requested = input.lines[index];
      const quantity = requested?.deliveredQty;
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > line.quantityQty - previous[index]) fail('Delivered quantity exceeds the remaining order quantity.');
      return { kind: line.kind, productId: line.productId, name: line.kind === 'special' ? line.specialSnapshot?.name || '' : line.itemSnapshot?.name || '', orderedQty: line.quantityQty, deliveredQty: quantity, unit: line.kind === 'special' ? 'combo' : line.orderUnitName || line.itemSnapshot?.unitSymbol || '' };
    });
    if (!lines.some((line) => line.deliveredQty > 0)) fail('Deliver at least one item.');
    const complete = lines.every((line, index) => previous[index] + line.deliveredQty === line.orderedQty);
    const deliveryNumber = `DEL-${order.orderNumber}-${String(history.size + 1).padStart(2, '0')}`;
    tx.create(deliveryRef, { deliveryNumber, orderId: input.orderId, orderNumber: order.orderNumber, ownerUid: order.ownerUid, assignedUserId: order.assignedUserId || order.ownerUid, assignedUserName: assignee.data()?.displayName || assignee.data()?.fullName || '', customerId: order.customerId, customerSnapshot: order.customerSnapshot, lines, remarks: input.remarks.trim(), deliveredAt: FieldValue.serverTimestamp(), deliveredBy: uid, deliveredByName: actor.data().displayName || actor.data().fullName || '', complete, createdAt: FieldValue.serverTimestamp() });
    tx.update(orderRef, { status: order.invoiceId ? 'invoiced' : complete ? 'delivered' : 'confirmed', deliveryCount: history.size + 1, lastDeliveryId: deliveryRef.id, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(db.collection('auditLogs').doc(), { type: 'order.delivery_created', actorUid: uid, actorName: actor.data().displayName || actor.data().fullName || '', ownerUid: order.ownerUid, referenceType: 'order', referenceId: input.orderId, orderNumber: order.orderNumber, customerId: order.customerId, customerName: order.customerSnapshot?.fullName || '', detail: { deliveryId: deliveryRef.id, deliveryNumber, complete }, outcome: 'success', at: FieldValue.serverTimestamp() });
    return { deliveryId: deliveryRef.id, deliveryNumber, complete };
  });
}
