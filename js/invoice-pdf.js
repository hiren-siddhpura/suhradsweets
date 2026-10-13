// Only customer-facing fields enter the invoice model. Sabha, UIDs and audit data stay out.
const money = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateText = (stamp) => stamp?.toDate?.()?.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) || (typeof stamp === 'string' ? stamp : '');

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
  return `<article class="invoice-sheet">
    <header class="invoice-sheet-header"><div class="invoice-brand"><img class="invoice-sheet-logo" src="./logo/suhradsweets.png" alt="Suhrad Sweets"><strong class="invoice-business-name">SUHRAD SWEETS</strong></div><div class="invoice-heading"><h2>INVOICE</h2></div></header>
    <div class="invoice-detail-grid"><section class="invoice-card"><span class="invoice-card-icon" aria-hidden="true">●</span><div><h3>Bill To</h3><strong>${e(model.customer.name)}</strong>${[model.customer.contact, model.customer.address, model.customer.area].filter(Boolean).map((value) => `<p>${e(value)}</p>`).join('')}</div></section><section class="invoice-card"><span class="invoice-card-icon" aria-hidden="true">▤</span><div><h3>Invoice Details</h3><dl><dt>Invoice No.</dt><dd>${e(model.invoiceNumber)}</dd><dt>Invoice Date</dt><dd>${e(model.date)}</dd><dt>Order No.</dt><dd>${e(model.orderNumber)}</dd><dt>Payment Status</dt><dd><span class="invoice-status">${e(model.status)}</span></dd>${model.business.fssaiLicenseNo ? `<dt>FSSAI License No.</dt><dd>${e(model.business.fssaiLicenseNo)}</dd>` : ''}</dl></div></section></div>
    <table class="invoice-lines"><thead><tr><th>#</th><th>Item Description</th><th>Qty</th><th>Unit</th><th>Rate (INR)</th><th>Amount (INR)</th></tr></thead><tbody>${model.lines.map((line, index) => `<tr><td>${index + 1}</td><td>${e(line.description)}</td><td>${e((line.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }))}</td><td>${e(line.unit)}</td><td>${e(money(line.unitPricePaise))}</td><td>${e(money(line.lineTotalPaise))}</td></tr>`).join('')}</tbody></table>
    <div class="invoice-totals"><div><span>Subtotal</span><strong>${e(money(model.subtotalPaise))}</strong></div><div class="invoice-grand"><span>Grand Total</span><strong>${e(money(model.totalPaise))}</strong></div><div><span>Amount Paid</span><strong>${e(money(model.verifiedPaidPaise))}</strong></div><div class="invoice-balance"><span>Balance Due</span><strong>${e(money(model.balanceDuePaise))}</strong></div></div>
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
  const dark = '#17232b', orange = '#df6909', pale = '#ffe7d2', border = '#eee2d9';
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 794, 1123);
  ctx.drawImage(logo, 44, 42, 330, 110);
  ctx.fillStyle = orange; ctx.textAlign = 'center'; ctx.font = 'bold 19px Arial'; ctx.fillText('SUHRAD SWEETS', 210, 180);
  ctx.strokeStyle = '#f28c35'; line(394, 36, 394, 187);
  ctx.fillStyle = '#fff2e7'; ctx.fillRect(432, 36, 318, 75);
  ctx.fillStyle = orange; ctx.font = 'bold 40px Arial'; ctx.fillText('INVOICE', 591, 87);
  if (pageCount > 1) { ctx.font = '11px Arial'; ctx.fillText(`Page ${pageIndex + 1} of ${pageCount}`, 591, 130); }

  ctx.fillStyle = '#fffcf9'; ctx.fillRect(44, 211, 338, 170); ctx.fillRect(400, 211, 350, 170);
  ctx.strokeStyle = border; line(44, 211, 382, 211); line(44, 381, 382, 381); line(400, 211, 750, 211); line(400, 381, 750, 381);
  ctx.fillStyle = pale; ctx.fillRect(58, 227, 39, 39); ctx.fillRect(414, 227, 39, 39);
  ctx.fillStyle = orange; ctx.font = 'bold 17px Arial'; ctx.fillText('●', 77, 254); ctx.fillText('▤', 433, 254);
  ctx.textAlign = 'left'; ctx.font = 'bold 14px Arial'; ctx.fillText('BILL TO', 108, 250); ctx.fillText('INVOICE DETAILS', 465, 250);
  ctx.fillStyle = dark; ctx.font = 'bold 19px Arial'; wrapped(ctx, model.customer.name, 108, 279, 258, 20, 1);
  ctx.font = '13px Arial';
  let customerY = 301;
  for (const value of [model.customer.contact, model.customer.address, model.customer.area].filter(Boolean)) customerY += wrapped(ctx, value, 108, customerY, 258, 17, 2) * 17;
  const details = [['Invoice No.', model.invoiceNumber], ['Invoice Date', model.date], ['Order No.', model.orderNumber], ['Payment Status', model.status]];
  if (model.business.fssaiLicenseNo) details.push(['FSSAI License No.', model.business.fssaiLicenseNo]);
  details.forEach(([label, value], index) => {
    const y = 278 + index * 23;
    ctx.fillStyle = dark; ctx.font = '12px Arial'; ctx.textAlign = 'left'; ctx.fillText(label, 465, y);
    ctx.textAlign = 'right'; ctx.font = index === 3 ? 'bold 12px Arial' : '12px Arial'; ctx.fillStyle = index === 3 ? '#aa2c1d' : dark;
    wrapped(ctx, value, 738, y, 145, 13, 1);
  });

  const tableTop = 405, headerHeight = 43, rowHeight = 49, tableBottom = tableTop + headerHeight + pageLines.length * rowHeight;
  ctx.fillStyle = pale; ctx.fillRect(44, tableTop, 706, headerHeight);
  ctx.strokeStyle = border; line(44, tableTop, 750, tableTop); line(44, tableBottom, 750, tableBottom);
  ctx.fillStyle = dark; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center'; ctx.fillText('#', 68, 432);
  ctx.textAlign = 'left'; ctx.fillText('Item Description', 108, 432);
  ctx.textAlign = 'center'; ctx.fillText('Qty', 414, 432); ctx.fillText('Unit', 495, 432);
  ctx.textAlign = 'right'; ctx.fillText('Rate (INR)', 634, 432); ctx.fillText('Amount (INR)', 739, 432);
  pageLines.forEach((item, index) => {
    const top = tableTop + headerHeight + index * rowHeight, baseline = top + 29;
    ctx.fillStyle = dark; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.fillText(String(pageIndex * 9 + index + 1), 68, baseline);
    ctx.textAlign = 'left'; wrapped(ctx, item.description, 108, baseline, 258, 15, 2);
    ctx.textAlign = 'center'; ctx.fillText((item.quantityQty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }), 414, baseline); ctx.fillText(item.unit.slice(0, 12), 495, baseline);
    ctx.textAlign = 'right'; ctx.fillText(money(item.unitPricePaise), 634, baseline); ctx.fillText(money(item.lineTotalPaise), 739, baseline);
    ctx.strokeStyle = border; line(44, top + rowHeight, 750, top + rowHeight);
  });
  ctx.strokeStyle = border;
  for (const x of [44, 94, 383, 448, 543, 645, 750]) line(x, tableTop, x, tableBottom);

  if (pageIndex === pageCount - 1) {
    const top = tableBottom + 20, left = 400, width = 350;
    ctx.fillStyle = '#fffcf9'; ctx.fillRect(left, top, width, 164);
    ctx.fillStyle = pale; ctx.fillRect(left, top + 40, width, 43);
    ctx.fillStyle = '#fff0ed'; ctx.fillRect(left, top + 122, width, 42);
    ctx.strokeStyle = border; line(left, top, left + width, top); line(left, top + 164, left + width, top + 164);
    const totals = [['Subtotal', model.subtotalPaise], ['Grand Total', model.totalPaise], ['Amount Paid', model.verifiedPaidPaise], ['Balance Due', model.balanceDuePaise]];
    totals.forEach(([label, amount], index) => {
      const y = top + [27, 68, 108, 149][index];
      ctx.fillStyle = index === 3 ? '#a61e19' : dark; ctx.font = index === 1 || index === 3 ? 'bold 15px Arial' : '13px Arial';
      ctx.textAlign = 'left'; ctx.fillText(label, left + 17, y); ctx.textAlign = 'right'; ctx.fillText(money(amount), left + width - 17, y);
    });
  }
  ctx.textAlign = 'left';
}

export async function downloadInvoicePdf(invoice, business = {}, payments = null) {
  const model = invoicePdfModel(invoice, business, payments);
  const [{ PDFDocument }, logo] = await Promise.all([pdfLib(), invoiceLogo()]);
  const pdf = await PDFDocument.create();
  const pageWidth = 794, pageHeight = 1123, rowsPerPage = 9;
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
