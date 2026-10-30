import { fail, validId } from './operations.js';

export async function getOrderAnalytics(db, uid) {
  if (!validId(uid)) fail('Sign in is required.');
  const viewer = await db.doc(`users/${uid}`).get();
  if (!viewer.exists || viewer.data().active !== true || !['admin', 'account_admin', 'user'].includes(viewer.data().role)) fail('Active OMS access is required.');
  const staff = ['admin', 'account_admin'].includes(viewer.data().role);
  const [orderSnaps, itemSnaps, userSnaps, unitSnaps] = await Promise.all([
    (staff ? db.collection('orders') : db.collection('orders').where('assignedUserId', '==', uid)).get(),
    db.collection('items').get(),
    staff ? db.collection('users').get() : Promise.resolve(null),
    db.collection('units').get(),
  ]);
  const orders = orderSnaps.docs.filter((snap) => !['cancelled', 'deleted'].includes(snap.data().status) && !snap.data().deletedAt).map((snap) => {
    const order = snap.data();
    return { id: snap.id, ownerUid: order.ownerUid, assignedUserId: order.assignedUserId, customerId: order.customerId, customerName: order.customerSnapshot?.fullName || '', orderNumber: order.orderNumber || '', orderDate: order.orderDate || '', status: order.status || '', invoiceId: order.invoiceId || '', grandTotalPaise: Number.isSafeInteger(order.grandTotal) ? order.grandTotal : null, lines: (order.lines || []).filter((line) => line.kind === 'item').map((line) => ({ productId: line.productId, name: line.itemSnapshot?.name || '', quantityQty: line.quantityQty, orderUnitId: line.orderUnitId || '', orderUnitName: line.orderUnitName || '', unitSymbol: line.itemSnapshot?.unitSymbol || '' })) };
  });
  const customerIds = [...new Set(orders.map((order) => order.customerId).filter(validId))];
  const customerSnaps = [];
  for (let start = 0; start < customerIds.length; start += 100) customerSnaps.push(...await db.getAll(...customerIds.slice(start, start + 100).map((id) => db.doc(`customers/${id}`))));
  const customers = customerSnaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, name: snap.data().fullName || '', phone: snap.data().contact || '', area: snap.data().area || '' }));
  const [invoiceSnaps, paymentSnaps] = await Promise.all([
    db.collection('invoices').get(),
    db.collection('payments').get(),
  ]);
  const orderIds = new Set(orders.map((order) => order.id));
  const invoices = invoiceSnaps.docs.filter((snap) => orderIds.has(snap.data().orderId)).map((snap) => ({ orderId: snap.data().orderId, paymentStatus: snap.data().paymentStatus || 'unpaid', verifiedPaidPaise: snap.data().verifiedPaidPaise || 0, totalPaise: snap.data().totalPaise || 0 }));
  const payments = paymentSnaps.docs.filter((snap) => orderIds.has(snap.data().orderId)).map((snap) => ({ orderId: snap.data().orderId, verificationStatus: snap.data().verificationStatus || '', reversed: Boolean(snap.data().reversalId) }));
  const users = staff ? userSnaps.docs.filter((snap) => ['admin', 'account_admin', 'user'].includes(snap.data().role)).map((snap) => ({ id: snap.id, name: snap.data().displayName || snap.data().fullName || snap.id })) : [{ id: uid, name: viewer.data().displayName || viewer.data().fullName || uid }];
  const unitSymbols = new Map(unitSnaps.docs.map((snap) => [snap.id, snap.data().symbol || snap.data().name || '']));
  return { viewerUid: uid, staff, users, items: itemSnaps.docs.filter((snap) => snap.data().active === true).map((snap) => ({ id: snap.id, name: snap.data().name || snap.id, unitSymbol: unitSymbols.get(snap.data().defaultUnitId) || '' })), orders, customers, invoices, payments };
}
