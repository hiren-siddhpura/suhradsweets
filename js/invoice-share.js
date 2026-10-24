export function whatsappPhone(customer = {}) {
  const raw = String(customer.contact || '').trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  const code = String(customer.countryCode || customer.dialCode || '').trim();
  let international = digits;
  if (raw.startsWith('+')) {
    // The explicit international prefix is authoritative.
  } else if (raw.startsWith('00')) {
    international = digits.slice(2);
  } else {
    if (!/^\+?\d{1,3}$/.test(code)) return null;
    const dial = code.replace(/\D/g, '');
    if (digits.startsWith('0') || digits.length < 7 || digits.length > 10) return null;
    international = dial + digits;
  }
  return /^[1-9]\d{7,14}$/.test(international) ? international : null;
}

export function whatsappInvoiceMessage(invoice) {
  const number = String(invoice.invoiceNumber || `INV-${invoice.orderNumber || ''}`);
  const total = (Number(invoice.totalPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Invoice ${number} · Total ₹${total}. I will attach the PDF invoice here.`;
}

export async function shareInvoicePdf(invoice, blob, { navigator: browserNavigator = navigator, open = (url) => window.open(url, '_blank', 'noopener,noreferrer'), download } = {}) {
  const filename = `${String(invoice.invoiceNumber || `INV-${invoice.orderNumber || ''}`).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  if (typeof File === 'function' && typeof browserNavigator.share === 'function' && typeof browserNavigator.canShare === 'function') {
    let file;
    try {
      file = new File([blob], filename, { type: 'application/pdf' });
      if (!browserNavigator.canShare({ files: [file] })) file = null;
    } catch { file = null; }
    if (file) {
      try {
        await browserNavigator.share({ files: [file], title: `Invoice ${invoice.invoiceNumber || ''}` });
        return 'shared';
      } catch (error) {
        if (error?.name === 'AbortError') return 'cancelled';
        throw new Error('The share failed. Your invoice is still available. Try again or download the PDF.');
      }
    }
  }
  const phone = whatsappPhone(invoice.customerSnapshot);
  download(blob, filename);
  if (!phone) return 'manual';
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(whatsappInvoiceMessage(invoice))}`;
  if (!open(url)) return 'popup-blocked';
  return 'whatsapp';
}
