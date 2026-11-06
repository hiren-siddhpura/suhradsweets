const activeStatuses = new Set(['confirmed', 'in_preparation', 'ready', 'invoiced', 'delivered']);

function lineKgMilli(line, quantityQty) {
  if (line.kind === 'special') {
    const components = line.specialSnapshot?.components || [];
    const perCombo = components.reduce((sum, part) => {
      const unit = String(part.itemSnapshot?.unitSymbol || '').toUpperCase();
      if (unit === 'KG') return sum + part.quantityQty;
      if (unit === 'GM' || unit === 'G') return sum + part.quantityQty / 1000;
      return sum;
    }, 0);
    return perCombo * quantityQty / 1000;
  }
  const unit = String(line.orderUnitName || line.itemSnapshot?.unitSymbol || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (['500 GM', '500GM'].includes(unit)) return quantityQty / 2;
  if (['250 GM', '250GM'].includes(unit)) return quantityQty / 4;
  if (unit === 'KG') return quantityQty;
  if (unit === 'GM' || unit === 'G') return quantityQty / 1000;
  return 0; // PCS and unknown units are not weight.
}

const percent = (part, total) => total > 0 ? part / total * 100 : 0;

export function deliveryStatistics(orders, deliveries) {
  const byOrder = new Map();
  for (const record of deliveries) {
    if (record.status === 'rolled_back' || record.rolledBackAt) continue;
    if (!byOrder.has(record.orderId)) byOrder.set(record.orderId, []);
    byOrder.get(record.orderId).push(record);
  }
  let deliveredOrders = 0, pendingOrders = 0, deliveredMilli = 0, pendingMilli = 0;
  for (const order of orders) {
    if (!activeStatuses.has(order.status) || !Array.isArray(order.lines) || !order.lines.length) continue;
    const history = byOrder.get(order.id) || [];
    let complete = true;
    order.lines.forEach((line, index) => {
      const ordered = Number.isSafeInteger(line.quantityQty) && line.quantityQty > 0 ? line.quantityQty : 0;
      const delivered = Math.min(ordered, Math.max(0, history.reduce((sum, record) => sum + (Number.isSafeInteger(record.lines?.[index]?.deliveredQty) ? record.lines[index].deliveredQty : 0), 0)));
      if (delivered < ordered) complete = false;
      deliveredMilli += lineKgMilli(line, delivered);
      pendingMilli += lineKgMilli(line, ordered - delivered);
    });
    if (complete) deliveredOrders++; else pendingOrders++;
  }
  const totalOrders = deliveredOrders + pendingOrders, totalMilli = deliveredMilli + pendingMilli;
  return { deliveredOrders, pendingOrders, deliveredKg: deliveredMilli / 1000, pendingKg: pendingMilli / 1000,
    deliveredOrderPercent: percent(deliveredOrders, totalOrders), pendingOrderPercent: percent(pendingOrders, totalOrders),
    deliveredKgPercent: percent(deliveredMilli, totalMilli), pendingKgPercent: percent(pendingMilli, totalMilli) };
}

export function assignedDeliveryWorkload(orders, deliveries, userNames = new Map()) {
  const groups = new Map();
  for (const order of orders) {
    if (!activeStatuses.has(order.status) || !order.assignedUserId || !order.lines?.length) continue;
    let group = groups.get(order.assignedUserId);
    if (!group) {
      group = { userId: order.assignedUserId, userName: userNames.get(order.assignedUserId) || order.assignedUserName || order.assignedUserId, pendingOrders: 0, pendingKg: 0, deliveredOrders: 0, deliveredKg: 0, progress: 0, pending: [] };
      groups.set(order.assignedUserId, group);
    }
    const stats = deliveryStatistics([order], deliveries);
    group.pendingOrders += stats.pendingOrders;
    group.pendingKg += stats.pendingKg;
    group.deliveredOrders += stats.deliveredOrders;
    group.deliveredKg += stats.deliveredKg;
    if (stats.pendingOrders) group.pending.push({ order, pendingKg: stats.pendingKg, status: stats.deliveredKg > 0 ? 'Partial' : 'Pending' });
  }
  return [...groups.values()].filter((group) => group.pendingOrders).map((group) => ({ ...group,
    progress: group.deliveredKg + group.pendingKg > 0 ? group.deliveredKg / (group.deliveredKg + group.pendingKg) * 100 : 0,
  })).sort((a, b) => a.userName.localeCompare(b.userName));
}

export function deliveryOrderState(order, deliveries) {
  if (!activeStatuses.has(order?.status) || !order.lines?.length) return null;
  const active = deliveries.filter((record) => record.orderId === order.id && record.status !== 'rolled_back' && !record.rolledBackAt);
  let hasDelivered = false, hasRemaining = false;
  order.lines.forEach((line, index) => {
    const ordered = Math.max(0, line.quantityQty || 0);
    const delivered = Math.min(ordered, active.reduce((sum, record) => sum + Math.max(0, record.lines?.[index]?.deliveredQty || 0), 0));
    if (delivered) hasDelivered = true;
    if (delivered < ordered) hasRemaining = true;
  });
  return hasRemaining ? hasDelivered ? 'partial' : 'pending' : 'delivered';
}
