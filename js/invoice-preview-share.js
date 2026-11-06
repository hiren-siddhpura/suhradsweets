export function previewWhatsappPhone(contact) {
  const raw = String(contact || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  return '';
}

export async function sharePreviewPdf(record, blob, filename, { browserNavigator = globalThis.navigator, FileType = globalThis.File, open = (url) => window.open(url, '_blank', 'noopener,noreferrer'), download } = {}) {
  const text = `Jay Swaminarayan 🙏\nPlease find your Suhrad Sweets Invoice Preview ${record.reference} attached for your review.`;
  if (typeof FileType === 'function' && browserNavigator.canShare && browserNavigator.share) {
    const file = new FileType([blob], filename, { type: 'application/pdf' });
    if (browserNavigator.canShare({ files: [file] })) {
      await browserNavigator.share({ files: [file], text, title: 'Suhrad Sweets Invoice Preview' });
      return 'shared';
    }
  }
  download(blob, filename);
  const number = previewWhatsappPhone(record.customerSnapshot?.contact);
  const fallback = `Jay Swaminarayan 🙏\nPlease review your Suhrad Sweets Invoice Preview ${record.reference}. I will attach the downloaded PDF here.`;
  const url = `https://wa.me/${number}?text=${encodeURIComponent(fallback)}`;
  return open(url) ? 'manual' : 'popup-blocked';
}
