// An explicit allowlist keeps internal customer fields (including Sabha) out of exported PDFs.
export function invoicePdfModel(invoice) {
  const customer = invoice.customerSnapshot || {};
  return {
    invoiceNumber: String(invoice.invoiceNumber || `INV-${invoice.orderNumber || ''}`),
    orderNumber: String(invoice.orderNumber || ''),
    date: invoice.issuedAt?.toDate?.()?.toLocaleDateString('en-IN') || '',
    customer: { name: String(customer.fullName || ''), contact: String(customer.contact || ''), address: String(customer.address || ''), area: String(customer.area || '') },
    lines: (invoice.lines || []).map((line) => ({ description: String(line.description || line.itemSnapshot?.name || line.specialSnapshot?.name || ''), quantityQty: Number(line.quantityQty || 0), unit: String(line.unit || line.itemSnapshot?.unitSymbol || (line.kind === 'special' ? 'combo' : '')), unitPricePaise: Number(line.unitPricePaise || 0), lineTotalPaise: Number(line.lineTotalPaise || 0) })),
    totalPaise: Number(invoice.totalPaise || 0), verifiedPaidPaise: Number(invoice.verifiedPaidPaise || 0), balanceDuePaise: Number(invoice.totalPaise || 0) - Number(invoice.verifiedPaidPaise || 0),
  };
}

const money = (paise) => `INR ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let loading;
async function pdfLib() {
  if (window.PDFLib) return window.PDFLib;
  loading ||= new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'; script.onload = () => resolve(window.PDFLib); script.onerror = () => reject(new Error('PDF library could not load.')); document.head.append(script); });
  return loading;
}

export async function downloadInvoicePdf(invoice) {
  const model = invoicePdfModel(invoice);
  const { PDFDocument } = await pdfLib();
  const pdf = await PDFDocument.create();
  const pageHeight = 1123, pageWidth = 794;
  const rowsPerPage = 17;
  const rows = model.lines;
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const canvas = document.createElement('canvas'); canvas.width = pageWidth * 2; canvas.height = pageHeight * 2;
    const ctx = canvas.getContext('2d'); ctx.scale(2, 2); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageWidth, pageHeight);
    ctx.fillStyle = '#a94b14'; ctx.font = 'bold 25px Arial'; ctx.fillText('Suhrad Sweets', 45, 58);
    ctx.fillStyle = '#302821'; ctx.font = 'bold 19px Arial'; ctx.fillText('INVOICE', 620, 58);
    ctx.font = '14px Arial'; ctx.fillText(model.invoiceNumber, 45, 103); ctx.fillText(`Date: ${model.date}`, 45, 128); ctx.fillText(`Order: ${model.orderNumber}`, 45, 153);
    ctx.font = 'bold 14px Arial'; ctx.fillText('Bill to', 45, 198); ctx.font = '14px Arial';
    [model.customer.name, model.customer.contact, model.customer.address, model.customer.area].forEach((value, i) => ctx.fillText(value.slice(0, 90), 45, 225 + i * 23));
    ctx.fillStyle = '#f7eee7'; ctx.fillRect(40, 338, 714, 38); ctx.fillStyle = '#302821'; ctx.font = 'bold 13px Arial';
    ctx.fillText('Item', 50, 362); ctx.fillText('Qty', 390, 362); ctx.fillText('Unit', 455, 362); ctx.fillText('Rate', 530, 362); ctx.fillText('Total', 650, 362);
    ctx.font = '13px Arial';
    rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage).forEach((line, i) => { const y = 404 + i * 34; ctx.fillText(line.description.slice(0, 42), 50, y); ctx.fillText(String(line.quantityQty / 1000), 390, y); ctx.fillText(line.unit.slice(0, 10), 455, y); ctx.fillText(money(line.unitPricePaise), 530, y); ctx.fillText(money(line.lineTotalPaise), 650, y); });
    if (pageIndex === pageCount - 1) { ctx.font = 'bold 15px Arial'; ctx.fillText(`Invoice total: ${money(model.totalPaise)}`, 45, 1010); ctx.fillText(`Verified payments: ${money(model.verifiedPaidPaise)}`, 45, 1035); ctx.fillText(`Balance due: ${money(model.balanceDuePaise)}`, 45, 1060); }
    ctx.font = '11px Arial'; ctx.fillText(`Page ${pageIndex + 1} of ${pageCount}`, 680, 1090);
    const page = pdf.addPage([pageWidth, pageHeight]); const image = await pdf.embedPng(canvas.toDataURL('image/png')); page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  const bytes = await pdf.save(); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = `${model.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
