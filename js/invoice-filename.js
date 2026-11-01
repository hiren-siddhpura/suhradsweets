export function invoicePdfFilename(invoice) {
  const safePart = (value) => String(value ?? '').normalize('NFC').trim()
    .replace(/\s+/gu, '_')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[._]+|[._]+$/gu, '');
  const number = safePart(invoice.invoiceNumber || `INV-${invoice.orderNumber || ''}`) || 'Invoice';
  const customer = safePart(invoice.customerSnapshot?.fullName);
  return `${customer ? `${customer}_` : ''}${number}.pdf`;
}
