// Only customer-facing fields enter the invoice model. Sabha, UIDs and audit data stay out.
const money = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateText = (stamp) => stamp?.toDate?.()?.toLocaleDateString('en-IN') || (typeof stamp === 'string' ? stamp : '');

export function invoicePdfModel(invoice, business = {}, payments = null) {
  const customer = invoice.customerSnapshot || {};
  const lines = (invoice.lines || []).map((line) => ({
    description: String(line.description || line.itemSnapshot?.name || line.specialSnapshot?.name || ''),
    quantityQty: Number(line.quantityQty || 0),
    unit: String(line.unit || line.itemSnapshot?.unitSymbol || (line.kind === 'special' ? 'combo' : '')),
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
  if (!Number.isSafeInteger(totalPaise) || !Number.isSafeInteger(verifiedPaidPaise) || verifiedPaidPaise < 0 || verifiedPaidPaise > totalPaise) throw new Error('Invoice balance is invalid.');
  const status = invoice.paymentStatus === 'paid' && verifiedPaidPaise === totalPaise ? 'Paid'
    : verifiedPaidPaise >= totalPaise && totalPaise > 0 ? 'Awaiting final approval'
      : verifiedPaidPaise > 0 ? 'Partially Paid'
        : invoice.paymentStatus === 'in_process' ? 'Payment in process' : 'Unpaid';
  return {
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
  const businessLines = [model.business.address, model.business.contactNumber, model.business.fssaiLicenseNo ? `FSSAI License No.: ${model.business.fssaiLicenseNo}` : ''].filter(Boolean);
  const verifiedModes = [...new Set(model.verifiedPayments.map((payment) => payment.mode === 'bank_transfer' ? 'Bank transfer' : payment.mode.toUpperCase()))];
  return `<article class="invoice-sheet">
    <header class="invoice-sheet-header"><div><img class="invoice-sheet-logo" src="./logo/suhradsweets.png" alt="Suhrad Sweets"><strong class="invoice-business-name">${e(model.business.name)}</strong>${businessLines.map((line) => `<p>${e(line)}</p>`).join('')}</div><div class="invoice-heading"><h2>INVOICE</h2><span>${e(model.status)}</span></div></header>
    <div class="invoice-detail-grid"><section><h3>Bill To</h3><strong>${e(model.customer.name)}</strong>${[model.customer.contact, model.customer.address, model.customer.area].filter(Boolean).map((value) => `<p>${e(value)}</p>`).join('')}</section><section><h3>Invoice Details</h3><dl><dt>Invoice No.</dt><dd>${e(model.invoiceNumber)}</dd><dt>Date</dt><dd>${e(model.date)}</dd><dt>Order No.</dt><dd>${e(model.orderNumber)}</dd></dl></section></div>
    <table class="invoice-lines"><thead><tr><th>Item Description</th><th>Quantity</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${model.lines.map((line) => `<tr><td>${e(line.description)}</td><td>${e((line.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }))}</td><td>${e(line.unit)}</td><td>${e(money(line.unitPricePaise))}</td><td>${e(money(line.lineTotalPaise))}</td></tr>`).join('')}</tbody></table>
    <div class="invoice-totals"><div><span>Subtotal</span><strong>${e(money(model.subtotalPaise))}</strong></div><div class="invoice-grand"><span>Grand Total</span><strong>${e(money(model.totalPaise))}</strong></div><div><span>Amount Paid (verified)</span><strong>${e(money(model.verifiedPaidPaise))}</strong></div><div class="invoice-balance"><span>Balance Due</span><strong>${e(money(model.balanceDuePaise))}</strong></div></div>
    ${verifiedModes.length ? `<section class="invoice-payment-info"><h3>Verified Payments</h3><p>${e(verifiedModes.join(', '))}</p>${model.verifiedPayments.filter((payment) => payment.reference).map((payment) => `<p>${e(payment.mode === 'bank_transfer' ? 'Bank transfer' : payment.mode.toUpperCase())} reference: ${e(payment.reference)}</p>`).join('')}</section>` : ''}
    <footer><p>Thank you for your business.</p>${model.business.contactNumber ? `<p>Contact: ${e(model.business.contactNumber)}</p>` : ''}<small>Electronically generated invoice.</small></footer>
  </article>`;
}

let loading;
let logoLoading;
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
function drawPage(ctx, model, logo, pageLines, pageIndex, pageCount) {
  const dark = '#302821', orange = '#b3551e', muted = '#74695f';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 794, 1123);
  ctx.drawImage(logo, 44, 26, 180, 60);
  ctx.fillStyle = dark; ctx.font = 'bold 18px Arial'; ctx.fillText(model.business.name, 44, 108);
  ctx.fillStyle = muted; ctx.font = '12px Arial';
  let businessY = 129;
  if (model.business.address) businessY += wrapped(ctx, model.business.address, 44, businessY, 340, 17, 2) * 17;
  if (model.business.contactNumber) { ctx.fillText(model.business.contactNumber, 44, businessY); businessY += 18; }
  if (model.business.fssaiLicenseNo) ctx.fillText(`FSSAI License No.: ${model.business.fssaiLicenseNo}`, 44, businessY);
  ctx.fillStyle = orange; ctx.font = 'bold 30px Arial'; ctx.textAlign = 'right'; ctx.fillText('INVOICE', 750, 66);
  ctx.fillStyle = dark; ctx.font = 'bold 13px Arial'; ctx.fillText(model.status, 750, 90); ctx.textAlign = 'left';
  ctx.strokeStyle = '#e6d6ca'; ctx.beginPath(); ctx.moveTo(44, 204); ctx.lineTo(750, 204); ctx.stroke();
  ctx.fillStyle = orange; ctx.font = 'bold 13px Arial'; ctx.fillText('BILL TO', 44, 233); ctx.fillText('INVOICE DETAILS', 430, 233);
  ctx.fillStyle = dark; ctx.font = 'bold 14px Arial'; wrapped(ctx, model.customer.name, 44, 258, 330, 18, 1);
  ctx.font = '12px Arial'; [model.customer.contact, model.customer.address, model.customer.area].filter(Boolean).forEach((value, index) => wrapped(ctx, value, 44, 280 + index * 20, 330, 15, 1));
  [`Invoice No.: ${model.invoiceNumber}`, `Date: ${model.date}`, `Order No.: ${model.orderNumber}`].forEach((value, index) => ctx.fillText(value, 430, 258 + index * 23));
  ctx.fillStyle = '#f7eee7'; ctx.fillRect(44, 354, 706, 38); ctx.fillStyle = dark; ctx.font = 'bold 12px Arial';
  ctx.fillText('Item Description', 54, 378); ctx.textAlign = 'right'; ctx.fillText('Quantity', 440, 378); ctx.textAlign = 'left'; ctx.fillText('Unit', 456, 378); ctx.textAlign = 'right'; ctx.fillText('Rate', 630, 378); ctx.fillText('Amount', 740, 378);
  pageLines.forEach((line, index) => {
    const y = 418 + index * 48; ctx.fillStyle = dark; ctx.font = '12px Arial'; ctx.textAlign = 'left'; wrapped(ctx, line.description, 54, y, 305, 14, 3);
    ctx.textAlign = 'right'; ctx.fillText((line.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }), 440, y);
    ctx.textAlign = 'left'; ctx.fillText(line.unit.slice(0, 12), 456, y); ctx.textAlign = 'right'; ctx.fillText(money(line.unitPricePaise), 630, y); ctx.fillText(money(line.lineTotalPaise), 740, y);
    ctx.strokeStyle = '#eee8e3'; ctx.beginPath(); ctx.moveTo(44, y + 35); ctx.lineTo(750, y + 35); ctx.stroke();
  });
  if (pageIndex === pageCount - 1) {
    const totals = [['Subtotal', model.subtotalPaise], ['Grand Total', model.totalPaise], ['Amount Paid (verified)', model.verifiedPaidPaise], ['Balance Due', model.balanceDuePaise]];
    totals.forEach(([label, amount], index) => { const y = 902 + index * 28; ctx.font = index === 1 || index === 3 ? 'bold 14px Arial' : '12px Arial'; ctx.fillStyle = index === 3 ? orange : dark; ctx.textAlign = 'left'; ctx.fillText(label, 494, y); ctx.textAlign = 'right'; ctx.fillText(money(amount), 740, y); });
    const refs = model.verifiedPayments.map((payment) => `${payment.mode === 'bank_transfer' ? 'Bank transfer' : payment.mode.toUpperCase()}${payment.reference ? `: ${payment.reference}` : ''}`);
    if (refs.length) { ctx.textAlign = 'left'; ctx.fillStyle = muted; ctx.font = '11px Arial'; wrapped(ctx, `Verified payments: ${refs.slice(0, 2).join('; ')}${refs.length > 2 ? `; ${refs.length - 2} more verified payment(s)` : ''}`, 44, 1004, 690, 14, 2); }
  }
  ctx.textAlign = 'left'; ctx.strokeStyle = '#e6d6ca'; ctx.beginPath(); ctx.moveTo(44, 1050); ctx.lineTo(750, 1050); ctx.stroke();
  ctx.fillStyle = dark; ctx.font = '12px Arial'; ctx.fillText('Thank you for your business.', 44, 1074);
  ctx.fillStyle = muted; ctx.font = '10px Arial'; ctx.fillText(model.business.contactNumber ? `Contact: ${model.business.contactNumber}` : 'Electronically generated invoice.', 44, 1092);
  ctx.textAlign = 'right'; ctx.fillText(`Page ${pageIndex + 1} of ${pageCount}`, 750, 1092); ctx.textAlign = 'left';
}

export async function downloadInvoicePdf(invoice, business = {}, payments = null) {
  const model = invoicePdfModel(invoice, business, payments);
  const [{ PDFDocument }, logo] = await Promise.all([pdfLib(), invoiceLogo()]);
  const pdf = await PDFDocument.create();
  const pageWidth = 794, pageHeight = 1123, rowsPerPage = 10;
  const pageCount = Math.max(1, Math.ceil(model.lines.length / rowsPerPage));
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const canvas = document.createElement('canvas'); canvas.width = pageWidth * 2; canvas.height = pageHeight * 2;
    const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
    drawPage(ctx, model, logo, model.lines.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage), pageIndex, pageCount);
    const page = pdf.addPage([pageWidth, pageHeight]); const image = await pdf.embedPng(canvas.toDataURL('image/png')); page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  const bytes = await pdf.save(); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = `${model.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000)?.unref?.();
}
