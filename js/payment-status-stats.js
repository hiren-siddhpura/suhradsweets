const amount = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
const percent = (part, total) => total > 0 ? part / total * 100 : 0;

export function paymentStatusStats(records, invoices, filters = {}) {
  const cancelledInvoiceIds = new Set(invoices.filter((invoice) => invoice.status === 'cancelled' || invoice.paymentStatus === 'cancelled').map((invoice) => invoice.id));
  const activeRecords = records.flatMap((item) => {
    if (item.type !== 'bulk') return cancelledInvoiceIds.has(item.row.invoiceId) ? [] : [item];
    const allocations = item.row.allocations || [];
    if (!allocations.some((allocation) => cancelledInvoiceIds.has(allocation.invoiceId))) return [item];
    // A mixed collection can include active and cancelled orders. Its allocations
    // are the only reliable way to keep the active share in summary figures.
    const active = allocations.filter((allocation) => !cancelledInvoiceIds.has(allocation.invoiceId));
    if (!active.length) return [];
    const entries = (item.row.entries || []).map((entry, index) => ({ ...entry, amountPaise: active.filter((allocation) => allocation.paymentIndex === index).reduce((sum, allocation) => sum + amount(allocation.amountPaise), 0) }));
    const activeAmount = entries.reduce((sum, entry) => sum + entry.amountPaise, 0);
    return [{ ...item, amount: activeAmount, row: { ...item.row, entries, allocations: active, approvedPaise: item.status === 'verified' ? activeAmount : 0 } }];
  });
  const entryMatches = (entry) => !filters.mode || entry.mode === filters.mode;
  const recordAmount = (item) => item.type === 'bulk' && filters.mode
    ? (item.row.entries || []).filter(entryMatches).reduce((sum, entry) => sum + amount(entry.amountPaise), 0)
    : amount(item.amount);
  const totalPayments = activeRecords.reduce((sum, item) => sum + recordAmount(item), 0);
  const pendingPayments = activeRecords.filter((item) => item.status === 'pending').reduce((sum, item) => sum + recordAmount(item), 0);
  const approved = activeRecords.filter((item) => item.status === 'verified');
  const approvedPayments = approved.reduce((sum, item) => sum + (item.type === 'bulk' && !filters.mode ? amount(item.row.approvedPaise ?? item.amount) : recordAmount(item)), 0);
  const cashCollection = approved.reduce((sum, item) => sum + (item.type === 'bulk'
    ? (item.row.entries || []).filter((entry) => entryMatches(entry) && entry.mode === 'cash').reduce((total, entry) => total + amount(entry.amountPaise), 0)
    : item.row.mode === 'cash' ? amount(item.amount) : 0), 0);
  const onlineCollection = approved.reduce((sum, item) => sum + (item.type === 'bulk'
    ? (item.row.entries || []).filter((entry) => entryMatches(entry) && (entry.mode === 'upi' || entry.mode === 'bank_transfer')).reduce((total, entry) => total + amount(entry.amountPaise), 0)
    : ['upi', 'bank_transfer'].includes(item.row.mode) ? amount(item.amount) : 0), 0);
  const restrictToRecords = Boolean(filters.search || filters.mode || filters.type || filters.status);
  const invoiceIds = new Set(activeRecords.flatMap((item) => item.type === 'bulk'
    ? (item.row.allocations || []).filter((allocation) => !filters.mode || item.row.entries?.[allocation.paymentIndex]?.mode === filters.mode).map((allocation) => allocation.invoiceId)
    : [item.row.invoiceId]));
  const pendingCollection = invoices.filter((invoice) => {
    if (!invoice || invoice.status === 'cancelled' || ['cancelled', 'overpaid'].includes(invoice.paymentStatus)) return false;
    if (!Number.isSafeInteger(invoice.totalPaise) || !Number.isSafeInteger(invoice.verifiedPaidPaise) || invoice.verifiedPaidPaise < 0 || invoice.totalPaise <= invoice.verifiedPaidPaise) return false;
    if (restrictToRecords && !invoiceIds.has(invoice.id)) return false;
    if (filters.user && invoice.ownerUid !== filters.user) return false;
    if (filters.customer && !String(invoice.customerSnapshot?.fullName || '').toLowerCase().includes(filters.customer.toLowerCase())) return false;
    const day = invoice.issuedAt?.toDate?.()?.toISOString().slice(0, 10) || invoice.issuedDate || '';
    if ((filters.from && day < filters.from) || (filters.to && day > filters.to)) return false;
    return true;
  }).reduce((sum, invoice) => sum + invoice.totalPaise - invoice.verifiedPaidPaise, 0);
  const totalCollection = pendingCollection + approvedPayments;
  return {
    totalPayments, pendingPayments, approvedPayments, pendingCollection, cashCollection, onlineCollection, totalCollection,
    totalPaymentsPercent: percent(totalPayments, totalPayments),
    pendingPaymentsPercent: percent(pendingPayments, totalPayments),
    approvedPaymentsPercent: percent(approvedPayments, totalPayments),
    pendingCollectionPercent: percent(pendingCollection, totalCollection),
    cashCollectionPercent: percent(cashCollection, totalCollection),
    onlineCollectionPercent: percent(onlineCollection, totalCollection),
  };
}
