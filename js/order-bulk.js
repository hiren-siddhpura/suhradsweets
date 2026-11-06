export function remainingDeliveryLines(order, deliveries) {
  return (order.lines || []).map((line, index) => {
    const delivered = deliveries.filter((record) => record.orderId === order.id && record.status !== 'rolled_back' && !record.rolledBackAt)
      .reduce((sum, record) => sum + (record.lines?.[index]?.deliveredQty || 0), 0);
    return { line, remainingQty: line.quantityQty - delivered };
  });
}

export function bulkEligibility(order, target, deliveries, profile = null) {
  if (order.archivedAt) return { reason: 'Archived order. Restore it first.' };
  if (target === 'confirmed' && profile?.role !== 'admin' && order.lines?.some((line) => line.kind === 'special')) return { reason: 'Only Admin may confirm special orders.' };
  if (target === 'confirmed') return order.status === 'draft' && !order.invoiceId
    ? { operation: 'confirmOrder', payload: { orderId: order.id } }
    : { reason: 'Only a historical Draft order can be confirmed.' };
  if (target === 'invoiced') {
    if (!['admin', 'account_admin'].includes(profile?.role)) return { reason: 'Bulk invoicing requires Admin or Account Admin access.' };
    if (order.invoiceId || order.status === 'invoiced') return { reason: 'An invoice already exists for this order.' };
    if (!['confirmed', 'delivered', 'in_preparation', 'ready'].includes(order.status)) return { reason: 'Only an active Confirmed or Delivered order can be invoiced.' };
    if (!order.orderNumber || !order.customerId || !order.customerSnapshot?.fullName || !order.orderDate) return { reason: 'Order or customer details are incomplete.' };
    if (!Array.isArray(order.stockDeductions) || !order.stockDeductions.length) return { reason: 'Confirmed stock snapshot is missing.' };
    if (!Array.isArray(order.lines) || !order.lines.length || order.lines.some((line) => !Number.isSafeInteger(line.quantityQty) || line.quantityQty <= 0 || !Number.isSafeInteger(line.unitPricePaise) || line.unitPricePaise < 0 || !Number.isSafeInteger(line.lineTotalPaise) || line.lineTotalPaise !== Math.round(line.quantityQty * line.unitPricePaise / 1000) || !(line.kind === 'item' ? line.itemSnapshot?.name : line.kind === 'special' && line.specialSnapshot?.name))) return { reason: 'Order item or price details are invalid.' };
    if (!Number.isSafeInteger(order.subtotal) || !Number.isSafeInteger(order.grandTotal) || order.subtotal < 0 || order.grandTotal < 0 || order.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0) !== order.subtotal) return { reason: 'Order totals are invalid.' };
    return { operation: 'createInvoiceFromOrder', payload: { orderId: order.id }, invoiceNumber: `INV-${order.orderNumber}` };
  }
  if (target !== 'delivered') return { reason: 'Choose a valid bulk action.' };
  if (order.invoiceId) return { reason: 'An invoice exists; use the individual delivery action.' };
  if (!['confirmed', 'in_preparation', 'ready'].includes(order.status)) return { reason: 'Order cannot change to Delivered in its current status.' };
  const remaining = remainingDeliveryLines(order, deliveries);
  if (!remaining.length || remaining.some(({ remainingQty }) => !Number.isSafeInteger(remainingQty) || remainingQty < 0)) return { reason: 'Order quantities need review.' };
  if (remaining.every(({ remainingQty }) => remainingQty === 0)) return { reason: 'Already fully delivered.' };
  return { operation: 'createDelivery', lines: remaining.map(({ remainingQty }) => ({ deliveredQty: remainingQty })) };
}

export function retainFilteredSelection(selectedIds, filteredOrders) {
  const allowed = new Set(filteredOrders.map((order) => order.id));
  return new Set([...selectedIds].filter((id) => allowed.has(id)));
}
