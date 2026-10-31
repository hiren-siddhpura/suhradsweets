import { fail, orderStockRestriction, qty, validId } from './operations.js';

async function viewer(db, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return { uid, staff: ['admin', 'account_admin'].includes(snap.data().role) };
}
const uniqueIds = (values, max) => {
  if (!Array.isArray(values) || values.length > max || values.some((id) => !validId(id))) fail('Invalid record selection.');
  return [...new Set(values)];
};
const nameOf = (profile) => profile?.fullName || profile?.displayName || 'Unknown user';

export async function getOrderStock(db, uid, input) {
  await viewer(db, uid);
  const ids = uniqueIds(input?.itemIds, 100);
  if (!ids.length) return { items: [] };
  const items = await db.getAll(...ids.map((id) => db.doc(`items/${id}`)));
  const units = [...new Set(items.filter((snap) => snap.exists && snap.data().active === true).map((snap) => snap.data().defaultUnitId).filter(validId))];
  const [stocks, unitSnaps] = await Promise.all([
    db.getAll(...ids.map((id) => db.doc(`inventory/${id}`))),
    units.length ? db.getAll(...units.map((id) => db.doc(`units/${id}`))) : Promise.resolve([]),
  ]);
  const unitMap = new Map(unitSnaps.map((snap) => [snap.id, snap.exists ? snap.data().symbol : '']));
  return { items: ids.map((itemId, index) => {
    const item = items[index], stock = stocks[index];
    if (!item.exists || item.data().active !== true) return { itemId, availableQty: null, onHandQty: null, reservedQty: null, status: 'unavailable', unit: '' };
    const unit = unitMap.get(item.data().defaultUnitId) || '';
    const state = stock.exists ? stock.data() : null;
    if (!state || !qty(state.onHandQty) || !qty(state.reservedQty) || state.reservedQty > state.onHandQty || !qty(state.lowStockThresholdQty ?? 0) || !unit) return { itemId, availableQty: null, onHandQty: null, reservedQty: null, status: 'unavailable', unit };
    const { availableQty, reason } = orderStockRestriction(state);
    return { itemId, availableQty, onHandQty: state.onHandQty, reservedQty: state.reservedQty, lowStockThresholdQty: state.lowStockThresholdQty || 0, unit, status: reason === 'blocked' ? 'blocked' : availableQty === 0 ? 'out_of_stock' : reason === 'threshold' ? 'low_stock' : 'available' };
  }) };
}

export async function getPaymentNames(db, uid, input) {
  const session = await viewer(db, uid);
  const ids = uniqueIds(input?.paymentIds, 100);
  if (!ids.length) return { payments: [] };
  const payments = await db.getAll(...ids.map((id) => db.doc(`payments/${id}`)));
  if (payments.some((snap) => snap.exists && !session.staff && snap.data().ownerUid !== uid)) fail('Payment access is denied.');
  const userIds = [...new Set(payments.flatMap((snap) => snap.exists ? [snap.data().submittedBy, snap.data().verifiedBy, snap.data().receivedBy] : []).filter(validId))];
  const profiles = userIds.length ? await db.getAll(...userIds.map((id) => db.doc(`users/${id}`))) : [];
  const byUid = new Map(profiles.map((snap) => [snap.id, snap.exists ? nameOf(snap.data()) : 'Unknown user']));
  const invoiceIds = [...new Set(payments.filter((snap) => snap.exists && !snap.data().customerSnapshot?.fullName).map((snap) => snap.data().invoiceId).filter(validId))];
  const invoices = invoiceIds.length ? await db.getAll(...invoiceIds.map((id) => db.doc(`invoices/${id}`))) : [];
  const invoiceMap = new Map(invoices.map((snap) => [snap.id, snap.exists ? snap.data() : null]));
  const customerIds = [...new Set(invoices.map((snap) => snap.exists ? snap.data().customerId : null).filter(validId))];
  const customers = customerIds.length ? await db.getAll(...customerIds.map((id) => db.doc(`customers/${id}`))) : [];
  const customerMap = new Map(customers.map((snap) => [snap.id, snap.exists ? snap.data().fullName : null]));
  return { payments: payments.filter((snap) => snap.exists).map((snap) => ({
    paymentId: snap.id,
    customerName: snap.data().customerSnapshot?.fullName || invoiceMap.get(snap.data().invoiceId)?.customerSnapshot?.fullName || customerMap.get(invoiceMap.get(snap.data().invoiceId)?.customerId) || 'Unknown customer',
    submittedByName: snap.data().submittedByName || byUid.get(snap.data().submittedBy) || 'Unknown user',
    verifiedByName: snap.data().verifiedBy ? snap.data().verifiedByName || byUid.get(snap.data().verifiedBy) || 'Unknown user' : '',
    receivedByName: snap.data().receivedBy ? byUid.get(snap.data().receivedBy) || 'Unknown user' : '',
  })) };
}

export async function listOrderActivity(db, uid, input = {}) {
  const session = await viewer(db, uid);
  const filters = input.filters || {};
  for (const key of ['actor', 'customer', 'order', 'invoice', 'payment', 'type', 'from', 'to']) {
    if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key].length > 128)) fail('Invalid activity filter.');
  }
  if (input.cursor != null && !validId(input.cursor)) fail('Invalid activity cursor.');
  let query = db.collection('auditLogs').where('referenceType', '==', 'order');
  if (!session.staff) query = query.where('ownerUid', '==', uid);
  query = query.orderBy('at', 'desc');
  if (input.cursor) {
    const cursor = await db.doc(`auditLogs/${input.cursor}`).get();
    if (!cursor.exists || cursor.data().referenceType !== 'order' || !session.staff && cursor.data().ownerUid !== uid) fail('Activity cursor is unavailable.');
    query = query.startAfter(cursor);
  }
  const rows = [];
  let last = null, exhausted = false;
  while (rows.length < 20 && !exhausted) {
    const batch = await query.limit(50).get();
    if (batch.empty) break;
    let reachedPageLimit = false;
    for (const snap of batch.docs) {
      last = snap;
      const event = snap.data(), day = event.at?.toDate?.().toISOString().slice(0, 10) || '';
      if ((!filters.actor || `${event.actorUid} ${event.actorName || ''}`.toLowerCase().includes(filters.actor.toLowerCase()))
        && (!filters.customer || `${event.customerId || ''} ${event.customerName || ''}`.toLowerCase().includes(filters.customer.toLowerCase()))
        && (!filters.order || `${event.referenceId} ${event.orderNumber || ''}`.toLowerCase().includes(filters.order.toLowerCase()))
        && (!filters.invoice || `${event.detail?.changedFields?.invoiceId?.after || ''} ${event.type === 'order.invoice_created' ? `INV-${event.orderNumber || ''}` : ''}`.toLowerCase().includes(filters.invoice.toLowerCase()))
        && (!filters.payment || `${event.detail?.changedFields?.paymentId?.after || ''}`.toLowerCase().includes(filters.payment.toLowerCase()))
        && (!filters.type || event.type === filters.type)
        && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to)) {
        rows.push({ id: snap.id, type: event.type, orderId: event.referenceId, orderNumber: event.orderNumber || event.referenceId,
          actorUid: event.actorUid, actorName: event.actorName || 'Unknown user', customerId: event.customerId || '',
          customerName: event.customerName || 'Unknown customer', at: event.at?.toMillis?.() || null,
          changedFields: event.detail?.changedFields || {}, reason: event.detail?.reason || '', outcome: event.outcome || 'success' });
        if (rows.length === 20) { reachedPageLimit = true; break; }
      }
    }
    exhausted = !reachedPageLimit && batch.size < 50;
    if (!exhausted && rows.length < 20) query = query.startAfter(last);
  }
  return { rows, cursor: last?.id || null, hasMore: !exhausted && rows.length === 20 };
}

export async function listPaymentActivity(db, uid, input = {}) {
  const session = await viewer(db, uid);
  const filters = input.filters || {};
  for (const key of ['actor', 'customer', 'order', 'invoice', 'payment', 'type', 'from', 'to']) {
    if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key].length > 128)) fail('Invalid activity filter.');
  }
  if (input.cursor != null && !validId(input.cursor)) fail('Invalid activity cursor.');
  let query = db.collection('auditLogs').where('referenceType', '==', 'payment');
  if (!session.staff) query = query.where('ownerUid', '==', uid);
  query = query.orderBy('at', 'desc');
  if (input.cursor) {
    const cursor = await db.doc(`auditLogs/${input.cursor}`).get();
    if (!cursor.exists || cursor.data().referenceType !== 'payment' || !session.staff && cursor.data().ownerUid !== uid) fail('Activity cursor is unavailable.');
    query = query.startAfter(cursor);
  }
  const rows = [];
  let last = null, exhausted = false;
  while (rows.length < 20 && !exhausted) {
    const batch = await query.limit(50).get();
    if (batch.empty) break;
    let reachedPageLimit = false;
    for (const snap of batch.docs) {
      last = snap;
      const event = snap.data(), day = event.at?.toDate?.().toISOString().slice(0, 10) || '';
      if ((!filters.actor || `${event.actorUid} ${event.actorName || ''}`.toLowerCase().includes(filters.actor.toLowerCase()))
        && (!filters.customer || `${event.customerId || ''} ${event.customerName || ''}`.toLowerCase().includes(filters.customer.toLowerCase()))
        && (!filters.order || `${event.orderId || ''} ${event.orderNumber || ''}`.toLowerCase().includes(filters.order.toLowerCase()))
        && (!filters.invoice || `${event.invoiceId || ''} ${event.invoiceNumber || ''}`.toLowerCase().includes(filters.invoice.toLowerCase()))
        && (!filters.payment || `${event.paymentId || event.referenceId}`.toLowerCase().includes(filters.payment.toLowerCase()))
        && (!filters.type || event.type === filters.type)
        && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to)) {
        rows.push({ id: snap.id, type: event.type, paymentId: event.paymentId || event.referenceId,
          orderNumber: event.orderNumber || '', invoiceNumber: event.invoiceNumber || '',
          actorUid: event.actorUid, actorName: event.actorName || 'Unknown user',
          customerName: event.customerName || 'Unknown customer', at: event.at?.toMillis?.() || null,
          changedFields: event.detail?.changedFields || {}, reason: event.detail?.reason || '', outcome: event.outcome || 'success' });
        if (rows.length === 20) { reachedPageLimit = true; break; }
      }
    }
    exhausted = !reachedPageLimit && batch.size < 50;
    if (!exhausted && rows.length < 20) query = query.startAfter(last);
  }
  return { rows, cursor: last?.id || null, hasMore: !exhausted && rows.length === 20 };
}
