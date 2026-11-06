import { invoicePdfFilename } from './invoice-filename.js';
import { invoiceAmountWords } from './invoice-amount-words.js';

// Only customer-facing fields enter the invoice model. Sabha, UIDs and audit data stay out.
const money = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateText = (stamp) => stamp?.toDate?.()?.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) || (typeof stamp === 'string' ? stamp : '');
const invoiceTagline = 'Sweetness to Share, Quality with Care';
const invoiceFooterText = 'This is a computer-generated invoice and does not require a signature.';
const invoiceThanksText = 'Thank You for Your Order!';
const invoiceContact = (business) => `Contact : Sandipbhai (${business.contactNumber || '9558350540'})`;

export function invoicePdfModel(invoice, business = {}, payments = null) {
  const customer = invoice.customerSnapshot || {};
  const lines = (invoice.lines || []).map((line) => ({
    description: String(line.description || line.itemSnapshot?.name || line.specialSnapshot?.name || ''),
    quantityQty: Number(line.quantityQty || 0),
    unit: String(line.unit || line.orderUnitName || line.itemSnapshot?.unitSymbol || (line.kind === 'special' ? 'combo' : '')),
    unitPricePaise: Number(line.unitPricePaise || 0),
    lineTotalPaise: Number(line.lineTotalPaise || 0),
  }));
  const totalPaise = Number(invoice.totalPaise || 0);
  const verifiedPaidPaise = Number(invoice.verifiedPaidPaise || 0);
  const verifiedPayments = Array.isArray(payments) ? payments.filter((payment) => payment.verificationStatus === 'verified' && !payment.reversalId).map((payment) => ({
    amountPaise: Number(payment.amountPaise || 0),
    mode: String(payment.mode || ''),
    reference: payment.mode === 'cash' ? '' : String(payment.transactionNumber || ''),
  })) : [];
  if (Array.isArray(payments) && verifiedPayments.reduce((sum, payment) => sum + payment.amountPaise, 0) !== verifiedPaidPaise) throw new Error('Invoice payments could not be reconciled. Refresh and contact an administrator.');
  if (!Number.isSafeInteger(totalPaise) || !Number.isSafeInteger(verifiedPaidPaise) || verifiedPaidPaise < 0) throw new Error('Invoice balance is invalid.');
  const status = invoice.status === 'cancelled' || invoice.paymentStatus === 'cancelled' ? 'Cancelled'
    : verifiedPaidPaise > totalPaise ? 'Overpaid / credit review'
    : ['paid', 'ready_to_mark_paid'].includes(invoice.paymentStatus) && verifiedPaidPaise === totalPaise ? 'Paid'
    : verifiedPaidPaise >= totalPaise && totalPaise > 0 ? 'Payment in process'
      : verifiedPaidPaise > 0 ? 'Partially Paid'
        : invoice.paymentStatus === 'in_process' ? 'Payment in process' : 'Unpaid';
  return {
    documentType: invoice.documentType === 'preview' ? 'preview' : 'invoice',
    business: { name: 'Suhrad Sweets', address: String(business.address || '').trim(), contactNumber: String(business.contactNumber || '').trim(), fssaiLicenseNo: String(business.fssaiLicenseNo || '').trim() },
    invoiceNumber: String(invoice.invoiceNumber || `INV-${invoice.orderNumber || ''}`),
    orderNumber: String(invoice.orderNumber || ''), date: dateText(invoice.issuedAt), status,
    customer: { name: String(customer.fullName || ''), contact: String(customer.contact || ''), address: String(customer.address || ''), area: String(customer.area || '') },
    lines, subtotalPaise: Number(invoice.subtotal ?? lines.reduce((sum, line) => sum + line.lineTotalPaise, 0)),
    totalPaise, verifiedPaidPaise, balanceDuePaise: totalPaise - verifiedPaidPaise, verifiedPayments,
  };
}

export function invoicePreviewHtml(invoice, business = {}, payments = null) {
  const model = invoicePdfModel(invoice, business, payments);
  const e = escapeHtml;
  const preview = model.documentType === 'preview';
  return `<article class="invoice-sheet">
    <div class="invoice-top-blessing"><img src="./logo/invoice-blessing.png" alt="Gujarati blessing"></div>
    <header class="invoice-sheet-header"><div class="invoice-brand"><img class="invoice-sheet-logo" src="./logo/suhradsweets.png" alt="Suhrad Sweets"></div><div class="invoice-heading"><h2>${preview ? 'INVOICE PREVIEW' : 'INVOICE'}</h2><strong class="invoice-heading-brand">SUHRAD SWEETS</strong><span class="invoice-heading-tagline">${invoiceTagline}</span><span class="invoice-heading-contact"><span aria-hidden="true">☎</span> ${e(invoiceContact(model.business))}</span></div></header>
    <div class="invoice-detail-grid"><section class="invoice-card"><span class="invoice-card-icon" aria-hidden="true">●</span><div><h3>Bill To</h3><strong>${e(model.customer.name)}</strong>${[model.customer.contact, model.customer.address, model.customer.area].filter(Boolean).map((value) => `<p>${e(value)}</p>`).join('')}</div></section><section class="invoice-card"><span class="invoice-card-icon" aria-hidden="true">▤</span><div><h3>${preview ? 'Preview Details' : 'Invoice Details'}</h3><dl><dt>${preview ? 'Preview Ref.' : 'Invoice No.'}</dt><dd>${e(model.invoiceNumber)}</dd><dt>${preview ? 'Preview Date' : 'Invoice Date'}</dt><dd>${e(model.date)}</dd>${preview ? '' : `<dt>Order No.</dt><dd>${e(model.orderNumber)}</dd>`}${model.business.fssaiLicenseNo ? `<dt>FSSAI License No.</dt><dd>${e(model.business.fssaiLicenseNo)}</dd>` : ''}</dl></div></section></div>
    <table class="invoice-lines"><thead><tr><th>#</th><th>ITEM DESCRIPTION</th><th>QTY</th><th>UNIT</th><th>RATE (INR)</th><th>AMOUNT (INR)</th></tr></thead><tbody>${model.lines.map((line, index) => `<tr><td>${String(index + 1).padStart(2, '0')}</td><td>${e(line.description)}</td><td>${e((line.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }))}</td><td>${e(line.unit)}</td><td>${e(money(line.unitPricePaise))}</td><td>${e(money(line.lineTotalPaise))}</td></tr>`).join('')}</tbody></table>
    <div class="invoice-totals"><div class="invoice-grand"><span>GRAND TOTAL</span><strong>${e(money(model.totalPaise))}</strong></div><div class="invoice-amount-words"><strong>Amount in words:</strong><span>${e(invoiceAmountWords(model.totalPaise))}</span></div></div>
    <footer><strong>${preview ? 'For customer review only' : invoiceThanksText}</strong><small>${preview ? 'This preview is not a tax invoice or payment request.' : invoiceFooterText}</small></footer>
  </article>`;
}

let loading;
let logoLoading;
let blessingLoading;
async function pdfLib() {
  if (window.PDFLib) return window.PDFLib;
  loading ||= new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'; script.onload = () => resolve(window.PDFLib); script.onerror = () => reject(new Error('PDF library could not load.')); document.head.append(script); });
  return loading;
}
function invoiceLogo() {
  logoLoading ||= new Promise((resolve, reject) => {
    const logo = new Image(); logo.onload = () => resolve(logo); logo.onerror = () => reject(new Error('Invoice logo could not load.'));
    logo.src = new URL('../logo/suhradsweets.png', import.meta.url).href;
  });
  return logoLoading;
}
function invoiceBlessingImage() {
  blessingLoading ||= new Promise((resolve, reject) => {
    const blessing = new Image(); blessing.onload = () => resolve(blessing); blessing.onerror = () => reject(new Error('Invoice blessing image could not load.'));
    blessing.src = new URL('../logo/invoice-blessing.png', import.meta.url).href;
  });
  return blessingLoading;
}
function wrapped(ctx, value, x, y, width, lineHeight, limit = 2) {
  const words = String(value || '').split(/\s+/).flatMap((word) => {
    if (ctx.measureText(word).width <= width) return [word];
    const parts = []; let part = '';
    for (const character of word) {
      if (part && ctx.measureText(part + character).width > width) { parts.push(part); part = character; }
      else part += character;
    }
    if (part) parts.push(part);
    return parts;
  });
  let line = '', count = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { ctx.fillText(line, x, y + count * lineHeight); count++; line = word; if (count >= limit) break; }
    else line = next;
  }
  if (count < limit && line) ctx.fillText(line, x, y + count * lineHeight);
  return Math.min(limit, count + (line ? 1 : 0));
}
function drawPage(ctx, model, logo, blessing, pageLines, pageIndex, pageCount) {
  const preview = model.documentType === 'preview';
  const dark = '#17232b', orange = '#df6909', pale = '#ffe7d2', border = '#edc6a9';
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 794, 1123);
  ctx.drawImage(blessing, 314, 15, 166, 49);
  ctx.drawImage(logo, 44, 78, 330, 104);
  ctx.strokeStyle = '#f28c35'; line(394, 66, 394, 190);
  ctx.textAlign = 'right'; ctx.fillStyle = orange; ctx.font = preview ? 'bold 30px Arial' : 'bold 40px Arial'; ctx.fillText(preview ? 'INVOICE PREVIEW' : 'INVOICE', 734, 103);
  ctx.font = 'bold 27px Arial'; ctx.fillText('SUHRAD SWEETS', 734, 134, 310);
  ctx.fillStyle = '#17232b'; ctx.font = 'italic 15px Arial'; ctx.fillText(invoiceTagline, 734, 156, 310);
  ctx.fillStyle = '#fff2e7'; ctx.fillRect(432, 166, 318, 30);
  const contact = invoiceContact(model.business);
  ctx.fillStyle = dark; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'right'; ctx.fillText(contact, 734, 186, 266);
  ctx.fillStyle = orange; ctx.font = 'bold 17px Arial'; ctx.textAlign = 'left'; ctx.fillText('☎', Math.max(445, 734 - Math.min(ctx.measureText(contact).width, 266) - 22), 186);
  if (pageCount > 1) { ctx.fillStyle = '#74695f'; ctx.font = '11px Arial'; ctx.textAlign = 'right'; ctx.fillText(`Page ${pageIndex + 1} of ${pageCount}`, 734, 205); }

  ctx.fillStyle = '#fffcf9'; ctx.fillRect(44, 211, 353, 170); ctx.fillRect(397, 211, 353, 170);
  ctx.fillStyle = pale; ctx.fillRect(44, 211, 353, 41); ctx.fillRect(397, 211, 353, 41);
  ctx.strokeStyle = '#edc6a9';
  for (const [left, right] of [[44, 397], [397, 750]]) { line(left, 211, right, 211); line(left, 381, right, 381); line(left, 211, left, 381); line(right, 211, right, 381); }
  ctx.fillStyle = orange; ctx.textAlign = 'left'; ctx.font = 'bold 17px Arial'; ctx.fillText('BILL TO', 62, 238); ctx.fillText(preview ? 'PREVIEW DETAILS' : 'INVOICE DETAILS', 415, 238);
  ctx.fillStyle = dark; ctx.font = 'bold 20px Arial'; const nameRows = wrapped(ctx, model.customer.name, 62, 281, 308, 22, 2);
  ctx.font = '13px Arial';
  let customerY = 283 + nameRows * 22;
  for (const value of [model.customer.contact, model.customer.address, model.customer.area].filter(Boolean)) {
    if (customerY > 363) break;
    customerY += wrapped(ctx, value, 62, customerY, 308, 16, Math.min(2, Math.floor((372 - customerY) / 16) + 1)) * 16;
  }
  const details = preview ? [['Preview Ref.', model.invoiceNumber], ['Preview Date', model.date]] : [['Invoice No.', model.invoiceNumber], ['Invoice Date', model.date], ['Order No.', model.orderNumber]];
  if (model.business.fssaiLicenseNo) details.push(['FSSAI License No.', model.business.fssaiLicenseNo]);
  details.forEach(([label, value], index) => {
    const y = 278 + index * 26;
    ctx.fillStyle = dark; ctx.font = '12px Arial'; ctx.textAlign = 'left'; ctx.fillText(label, 415, y);
    ctx.textAlign = 'right'; ctx.font = '12px Arial'; ctx.fillStyle = dark;
    ctx.fillText(String(value), 734, y, 170);
    if (index < details.length - 1) { ctx.strokeStyle = border; line(415, y + 8, 734, y + 8); }
  });

  const tableTop = 405, headerHeight = 43, rowHeight = 49, tableBottom = tableTop + headerHeight + pageLines.length * rowHeight;
  ctx.fillStyle = pale; ctx.fillRect(44, tableTop, 706, headerHeight);
  ctx.strokeStyle = border; line(44, tableTop, 750, tableTop); line(44, tableBottom, 750, tableBottom);
  ctx.fillStyle = dark; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center'; ctx.fillText('#', 68, 432);
  ctx.textAlign = 'left'; ctx.fillText('ITEM DESCRIPTION', 108, 432);
  ctx.textAlign = 'center'; ctx.fillText('QTY', 414, 432); ctx.fillText('UNIT', 495, 432);
  ctx.textAlign = 'right'; ctx.fillText('RATE (INR)', 634, 432); ctx.fillText('AMOUNT (INR)', 739, 432);
  pageLines.forEach((item, index) => {
    const top = tableTop + headerHeight + index * rowHeight, baseline = top + 29;
    ctx.fillStyle = dark; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.fillText(String(pageIndex * 9 + index + 1).padStart(2, '0'), 68, baseline);
    ctx.textAlign = 'left'; wrapped(ctx, item.description, 108, baseline, 258, 15, 2);
    ctx.textAlign = 'center'; ctx.fillText((item.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }), 414, baseline); ctx.fillText(item.unit.slice(0, 12), 495, baseline);
    ctx.textAlign = 'right'; ctx.fillText(money(item.unitPricePaise), 634, baseline); ctx.fillText(money(item.lineTotalPaise), 739, baseline);
    ctx.strokeStyle = border; line(44, top + rowHeight, 750, top + rowHeight);
  });
  ctx.strokeStyle = border;
  for (const x of [44, 94, 383, 448, 543, 645, 750]) line(x, tableTop, x, tableBottom);

  if (pageIndex === pageCount - 1) {
    const top = tableBottom, words = invoiceAmountWords(model.totalPaise);
    ctx.fillStyle = pale; ctx.fillRect(44, top, 706, 51);
    ctx.strokeStyle = '#edc6a9'; line(44, top + 51, 750, top + 51);
    ctx.fillStyle = dark; ctx.textAlign = 'left'; ctx.font = 'bold 20px Arial'; ctx.fillText('GRAND TOTAL', 62, top + 33);
    ctx.fillStyle = orange; ctx.textAlign = 'right'; ctx.font = 'bold 26px Arial'; ctx.fillText(money(model.totalPaise), 732, top + 35, 360);
    ctx.fillStyle = '#fffcf9'; ctx.fillRect(44, top + 51, 706, 60);
    ctx.strokeStyle = '#edc6a9'; line(44, top + 111, 750, top + 111);
    ctx.fillStyle = orange; ctx.textAlign = 'left'; ctx.font = 'bold 15px Arial'; ctx.fillText('Amount in words:', 62, top + 77);
    ctx.fillStyle = dark; ctx.textAlign = 'right'; ctx.font = '13px Arial'; wrapped(ctx, words, 732, top + 77, 480, 16, 2);
    ctx.fillStyle = orange; ctx.textAlign = 'center'; ctx.font = 'bold 23px Arial'; ctx.fillText(preview ? 'For customer review only' : invoiceThanksText, 397, top + 153);
    ctx.fillStyle = '#74695f'; ctx.font = 'italic 11px Arial'; ctx.fillText(preview ? 'This preview is not a tax invoice or payment request.' : invoiceFooterText, 397, top + 183);
  }
  ctx.textAlign = 'left';
}

export async function createInvoicePdfBlob(invoice, business = {}, payments = null) {
  const model = invoicePdfModel(invoice, business, payments);
  const [{ PDFDocument }, logo, blessing] = await Promise.all([pdfLib(), invoiceLogo(), invoiceBlessingImage()]);
  const pdf = await PDFDocument.create();
  const pageWidth = 794, pageHeight = 1123, rowsPerPage = 9;
  const pageCount = Math.max(1, Math.ceil(model.lines.length / rowsPerPage));
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const canvas = document.createElement('canvas'); canvas.width = pageWidth * 2; canvas.height = pageHeight * 2;
    const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
    drawPage(ctx, model, logo, blessing, model.lines.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage), pageIndex, pageCount);
    const page = pdf.addPage([pageWidth, pageHeight]); const image = await pdf.embedPng(canvas.toDataURL('image/png')); page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

export async function downloadInvoicePdf(invoice, business = {}, payments = null) {
  const blob = await createInvoicePdfBlob(invoice, business, payments);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = invoicePdfFilename(invoice); link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000)?.unref?.();
}
