export function pendingPaymentGroups(invoices, users = []) {
  const names = new Map(users.map((user) => [user.id, user.displayName || user.fullName || user.name || user.email || user.id]));
  const groups = new Map();
  for (const invoice of invoices) {
    const remaining = Math.max(0, Number(invoice.totalPaise || 0) - Number(invoice.verifiedPaidPaise || 0));
    if (!invoice.ownerUid || !remaining || ['cancelled', 'paid', 'overpaid'].includes(invoice.paymentStatus) || invoice.status === 'cancelled') continue;
    const group = groups.get(invoice.ownerUid) || { userId: invoice.ownerUid, userName: names.get(invoice.ownerUid) || invoice.assignedUserName || invoice.ownerUid, count: 0, amountPaise: 0, invoices: [] };
    group.count++;
    group.amountPaise += remaining;
    group.invoices.push({ ...invoice, remainingPaise: remaining });
    groups.set(invoice.ownerUid, group);
  }
  return [...groups.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}
