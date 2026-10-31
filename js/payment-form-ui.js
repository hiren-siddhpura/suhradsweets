const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (paise) => `₹${((Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (value) => value?.toDate?.()?.toLocaleDateString('en-IN') || '—';

export function paymentInvoiceSummary(invoice) {
  if (!invoice) return '';
  const outstanding = Math.max(0, (invoice.totalPaise || 0) - (invoice.verifiedPaidPaise || 0));
  return `<section class="payment-form-summary" aria-label="Selected invoice summary"><div class="payment-form-summary-title"><strong>${escapeHtml(invoice.invoiceNumber || 'Invoice')}</strong><span>${escapeHtml(invoice.customerSnapshot?.fullName || 'Customer')}</span></div><dl><div><dt>Invoice date</dt><dd>${escapeHtml(day(invoice.issuedAt))}</dd></div><div><dt>Invoice total</dt><dd>${money(invoice.totalPaise)}</dd></div><div><dt>Already paid</dt><dd>${money(invoice.verifiedPaidPaise)}</dd></div><div class="payment-form-balance"><dt>Outstanding</dt><dd>${money(outstanding)}</dd></div></dl></section>`;
}

export function paymentUpload({ id, label = 'Receipt attachment', dataAttribute = '' } = {}) {
  return `<label class="payment-upload" for="${escapeHtml(id)}"><span class="payment-upload-label">${escapeHtml(label)}</span><span class="payment-upload-button"><span aria-hidden="true">📎</span> Attach receipt</span><small>JPG, JPEG, PNG or PDF · Maximum 5 MB</small><input id="${escapeHtml(id)}" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" ${dataAttribute}></label>`;
}
