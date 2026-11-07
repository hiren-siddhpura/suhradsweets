export function pendingPaymentGroups(invoices, users = [], orders = []) {
  const names = new Map(users.map((user) => [user.id, user.displayName || user.fullName || user.name || user.email || user.id]));
  const assignees = new Map(orders.map((order) => [order.id, order.assignedUserId || order.ownerUid]));
  const groups = new Map();
  for (const invoice of invoices) {
    const assignedUserId = assignees.get(invoice.orderId) || invoice.assignedUserId || invoice.ownerUid;
    const remaining = Math.max(0, Number(invoice.totalPaise || 0) - Number(invoice.verifiedPaidPaise || 0));
    if (!assignedUserId || !remaining || ['cancelled', 'paid', 'overpaid'].includes(invoice.paymentStatus) || invoice.status === 'cancelled') continue;
    const group = groups.get(assignedUserId) || { userId: assignedUserId, userName: names.get(assignedUserId) || invoice.assignedUserName || assignedUserId, count: 0, amountPaise: 0, invoices: [] };
    group.count++;
    group.amountPaise += remaining;
    group.invoices.push({ ...invoice, remainingPaise: remaining });
    groups.set(assignedUserId, group);
  }
  return [...groups.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}
