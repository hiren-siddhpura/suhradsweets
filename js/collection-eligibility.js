export function eligibleCollectionInvoice(invoice) {
  return Boolean(invoice?.customerId)
    && Number.isSafeInteger(invoice.totalPaise)
    && Number.isSafeInteger(invoice.verifiedPaidPaise)
    && invoice.verifiedPaidPaise >= 0
    && invoice.totalPaise > invoice.verifiedPaidPaise
    && !['paid', 'in_process', 'cancelled', 'overpaid'].includes(invoice.paymentStatus)
    && invoice.status !== 'cancelled';
}
