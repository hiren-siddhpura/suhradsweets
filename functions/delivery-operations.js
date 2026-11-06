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
      if (existing.data().status === 'rolled_back' || existing.data().rolledBackAt) fail('This delivery was rolled back. Start a new delivery request.');
      return { deliveryId: deliveryRef.id, deliveryNumber: existing.data().deliveryNumber, duplicate: true };
    }
    if (!['confirmed', 'in_preparation', 'ready', 'invoiced'].includes(order.status) || order.archivedAt) fail('Only an active confirmed or invoiced order can be delivered.');
    const ordered = order.lines || [];
    if (input.lines.length !== ordered.length || !ordered.length) fail('Delivery lines do not match the order.');
    const activeHistory = history.docs.filter((doc) => doc.data().status !== 'rolled_back' && !doc.data().rolledBackAt);
    const previous = ordered.map((_, index) => activeHistory.reduce((total, doc) => total + (doc.data().lines?.[index]?.deliveredQty || 0), 0));
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
    tx.update(orderRef, { status: order.invoiceId ? 'invoiced' : complete ? 'delivered' : 'confirmed', deliveryCount: activeHistory.length + 1, lastDeliveryId: deliveryRef.id, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(db.collection('auditLogs').doc(), { type: 'order.delivery_created', actorUid: uid, actorName: actor.data().displayName || actor.data().fullName || '', ownerUid: order.ownerUid, referenceType: 'order', referenceId: input.orderId, orderNumber: order.orderNumber, customerId: order.customerId, customerName: order.customerSnapshot?.fullName || '', detail: { deliveryId: deliveryRef.id, deliveryNumber, complete }, outcome: 'success', at: FieldValue.serverTimestamp() });
    return { deliveryId: deliveryRef.id, deliveryNumber, complete };
  });
}

export async function rollbackDelivery(db, uid, input) {
  if (!validId(input?.deliveryId) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500) fail('Choose a delivery and enter a rollback reason of 500 characters or fewer.');
  const deliveryRef = db.doc(`deliveries/${input.deliveryId}`);
  return db.runTransaction(async (tx) => {
    const [actorSnap, deliverySnap] = await Promise.all([tx.get(db.doc(`users/${uid}`)), tx.get(deliveryRef)]);
    if (!actorSnap.exists || actorSnap.data().active !== true || actorSnap.data().role !== 'admin') fail('Access denied: only an active Admin may roll back deliveries.');
    if (!deliverySnap.exists) fail('Delivery does not exist.');
    const delivery = deliverySnap.data();
    if (delivery.status === 'rolled_back' || delivery.rolledBackAt) fail('This delivery has already been rolled back.');
    const orderRef = db.doc(`orders/${delivery.orderId}`);
    const [orderSnap, history] = await Promise.all([tx.get(orderRef), tx.get(db.collection('deliveries').where('orderId', '==', delivery.orderId))]);
    if (!orderSnap.exists || orderSnap.data().status === 'cancelled' || orderSnap.data().archivedAt) fail('Only a delivery on an active order can be rolled back.');
    const order = orderSnap.data();
    if (!Array.isArray(order.lines) || !order.lines.length || delivery.lines?.length !== order.lines.length) fail('Delivery quantities need review before rollback.');
    const active = history.docs.filter((doc) => doc.data().status !== 'rolled_back' && !doc.data().rolledBackAt);
    if (!active.some((doc) => doc.id === input.deliveryId)) fail('This delivery is no longer active.');
    const remaining = active.filter((doc) => doc.id !== input.deliveryId);
    const totals = order.lines.map((line, index) => {
      const ordered = line.quantityQty;
      const delivered = active.reduce((sum, doc) => sum + doc.data().lines?.[index]?.deliveredQty, 0);
      const after = remaining.reduce((sum, doc) => sum + doc.data().lines?.[index]?.deliveredQty, 0);
      if (!Number.isSafeInteger(ordered) || ordered <= 0 || !Number.isSafeInteger(delivered) || delivered > ordered || !Number.isSafeInteger(after) || after < 0 || after > ordered || !Number.isSafeInteger(delivery.lines[index].deliveredQty) || delivered - after !== delivery.lines[index].deliveredQty) fail('Delivery quantities need review before rollback.');
      return { ordered, after };
    });
    const complete = totals.every(({ ordered, after }) => after === ordered);
    const status = order.invoiceId ? 'invoiced' : complete ? 'delivered' : 'confirmed';
    const latest = [...remaining].sort((a, b) => (b.data().deliveredAt?.seconds || 0) - (a.data().deliveredAt?.seconds || 0))[0];
    const actorName = actorSnap.data().displayName || actorSnap.data().fullName || uid;
    tx.update(deliveryRef, { status: 'rolled_back', rollbackReason: input.reason.trim(), rolledBackAt: FieldValue.serverTimestamp(), rolledBackBy: uid, rolledBackByName: actorName });
    tx.update(orderRef, { status, deliveryCount: remaining.length, lastDeliveryId: latest?.id || null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(db.collection('auditLogs').doc(), { type: 'order.delivery_rolled_back', actorUid: uid, actorName, ownerUid: order.ownerUid, referenceType: 'order', referenceId: delivery.orderId, orderNumber: order.orderNumber, customerId: order.customerId, customerName: order.customerSnapshot?.fullName || '', detail: { deliveryId: input.deliveryId, deliveryNumber: delivery.deliveryNumber, originalDelivery: { deliveredAt: delivery.deliveredAt, lines: delivery.lines, deliveredBy: delivery.deliveredBy, deliveredByName: delivery.deliveredByName, assignedUserId: delivery.assignedUserId, assignedUserName: delivery.assignedUserName, customerSnapshot: delivery.customerSnapshot }, status: { before: order.status, after: status }, reason: input.reason.trim() }, outcome: 'success', at: FieldValue.serverTimestamp() });
    return { deliveryId: input.deliveryId, orderId: delivery.orderId, status };
  });
}
