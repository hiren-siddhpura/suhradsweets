import { collection, getDocs, limit, orderBy, query, startAfter, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const PAGE_SIZE = 20;
const SCAN_SIZE = 50;
const safeText = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const eventDay = (event) => event.at?.toDate?.()?.toISOString().slice(0, 10) || '';

function matches(event, filters) {
  const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
  const changed = detail.changedFields && typeof detail.changedFields === 'object' ? detail.changedFields : {};
  const includes = (filter, values) => !filter || values.join(' ').toLowerCase().includes(filter);
  return includes(safeText(filters.actor), [event.actorUid, event.actorName])
    && includes(safeText(filters.customer), [event.customerId, event.customerName, event.customerSnapshot?.fullName])
    && includes(safeText(filters.order), [event.orderId, event.referenceType === 'order' ? event.referenceId : '', event.orderNumber])
    && includes(safeText(filters.invoice), [event.invoiceId, event.invoiceNumber, changed.invoiceId?.after])
    && includes(safeText(filters.payment), [event.paymentId, event.referenceType === 'payment' ? event.referenceId : '', changed.paymentId?.after])
    && (!filters.type || event.type === filters.type)
    && (!filters.from || eventDay(event) >= filters.from)
    && (!filters.to || eventDay(event) <= filters.to);
}

function activityRow(snapshot) {
  const event = snapshot.data();
  return {
    id: snapshot.id,
    ...event,
    orderId: event.orderId || (event.referenceType === 'order' ? event.referenceId : ''),
    paymentId: event.paymentId || (event.referenceType === 'payment' ? event.referenceId : ''),
    actorName: event.actorName || 'Unknown user',
    customerName: event.customerName || event.customerSnapshot?.fullName || 'Unknown customer',
    changedFields: event.detail?.changedFields || {},
    reason: event.detail?.reason || '',
    outcome: event.outcome || 'success',
  };
}

// Firestore Rules independently enforce the same owner scope for ordinary Users.
// Filters are display filters, applied after the authorized query so untrusted input
// never affects the security boundary.
export async function listActivity(db, profile, uid, referenceType, filters = {}, cursor = null) {
  if (!['order', 'payment'].includes(referenceType)) throw new Error('Unknown activity type.');
  if (!uid || !profile?.active || !['admin', 'account_admin', 'user'].includes(profile.role)) throw new Error('Active OMS access is required.');
  const constraints = [where('referenceType', '==', referenceType)];
  if (profile.role === 'user') constraints.push(where('ownerUid', '==', uid));
  constraints.push(orderBy('at', 'desc'));

  const rows = [];
  let nextCursor = null;
  let queryCursor = cursor;
  do {
    const pageConstraints = queryCursor ? [...constraints, startAfter(queryCursor), limit(SCAN_SIZE)] : [...constraints, limit(SCAN_SIZE)];
    const result = await getDocs(query(collection(db, 'auditLogs'), ...pageConstraints));
    if (result.empty) return { rows, cursor: nextCursor, hasMore: false };
    for (const snapshot of result.docs) {
      queryCursor = snapshot;
      nextCursor = snapshot;
      const event = snapshot.data();
      if (matches(event, filters)) rows.push(activityRow(snapshot));
      if (rows.length === PAGE_SIZE) return { rows, cursor: nextCursor, hasMore: true };
    }
    if (result.size < SCAN_SIZE) return { rows, cursor: nextCursor, hasMore: false };
  } while (true);
}
