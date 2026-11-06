export function assignedInvoiceUser(invoice, ordersById) {
  const order = ordersById.get(invoice.orderId || invoice.id);
  return order ? order.assignedUserId || order.ownerUid || '' : '';
}

export function visibleBulkInvoices(invoices, filters, eligible) {
  const number = String(filters.number || '').toLowerCase();
  const customer = String(filters.customer || '').toLowerCase();
  return invoices.filter((row) => eligible(row)
    && (!filters.owner || row.assignedUserId === filters.owner)
    && (!number || String(row.invoiceNumber || '').toLowerCase().includes(number))
    && (!customer || String(row.customerSnapshot?.fullName || '').toLowerCase().includes(customer))
    && (!filters.status || (filters.status === 'partial' ? row.verifiedPaidPaise > 0 : row.verifiedPaidPaise === 0)));
}
