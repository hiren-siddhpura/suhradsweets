import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invoicePdfModel, invoicePreviewHtml, downloadInvoicePdf } from '../js/invoice-pdf.js';
import { invoiceAmountWords } from '../js/invoice-amount-words.js';
import { validateBusinessDetails } from '../js/business-settings.js';

const invoice = (paymentStatus = 'unpaid', verifiedPaidPaise = 0) => ({
  invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', issuedAt: { toDate: () => new Date('2026-10-12T00:00:00Z') },
  customerSnapshot: { fullName: 'Asha', contact: '9876543210', address: 'Main Street', area: 'Ahmedabad', sabha: true },
  lines: [{ description: 'Kaju Katli', quantityQty: 2000, unit: 'kg', unitPricePaise: 50000, lineTotalPaise: 100000 }, { description: 'Gift Box', quantityQty: 1000, unit: 'combo', unitPricePaise: 20000, lineTotalPaise: 20000 }],
  subtotal: 120000, totalPaise: 120000, verifiedPaidPaise, paymentStatus,
});

test('business details trim values, preserve leading zeros and allow omission', () => {
  assert.deepEqual(validateBusinessDetails({ address: ' Road ', contactNumber: ' 123 ', fssaiLicenseNo: ' 00123456789012 ' }), { address: 'Road', contactNumber: '123', fssaiLicenseNo: '00123456789012' });
  assert.equal(validateBusinessDetails().fssaiLicenseNo, '');
  assert.throws(() => validateBusinessDetails({ fssaiLicenseNo: '<script>' }), /FSSAI/);
});

test('amount in words uses the stored total, Indian units and paise', () => {
  assert.equal(invoiceAmountWords(4494000), 'Rupees Forty-Four Thousand Nine Hundred Forty Only.');
  assert.equal(invoiceAmountWords(10000125), 'Rupees One Lakh One and Twenty-Five Paise Only.');
  assert.equal(invoiceAmountWords(0), 'Rupees Zero Only.');
  assert.throws(() => invoiceAmountWords(-1), /total/);
});

test('preview uses snapshots, safe business details and verified payments only', () => {
  const payment = { amountPaise: 40000, verificationStatus: 'verified', mode: 'upi', transactionNumber: 'UPI-123' };
  const pending = { amountPaise: 80000, verificationStatus: 'unverified', mode: 'cash' };
  const model = invoicePdfModel(invoice('in_process', 40000), { fssaiLicenseNo: '00123456789012' }, [payment, pending]);
  assert.equal(model.status, 'Partially Paid'); assert.equal(model.balanceDuePaise, 80000);
  assert.equal(model.verifiedPayments.length, 1); assert.equal(model.lines[1].description, 'Gift Box');
  const html = invoicePreviewHtml(invoice('in_process', 40000), { fssaiLicenseNo: '00123456789012' }, [payment, pending]);
  for (const text of ['FSSAI License No.', '00123456789012', 'Asha', 'INV-SS-1', 'SS-1', 'Kaju Katli', 'Gift Box', '₹1,200.00', 'invoice-blessing.png', 'SUHRAD SWEETS', 'Sweetness to Share, Quality with Care', 'Sandipbhai', 'GRAND TOTAL', 'Rupees One Thousand Two Hundred Only.', 'Thank You for Your Order!', 'This is a computer-generated invoice and does not require a signature.']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<span>Subtotal<\/span>/);
  assert.match(invoicePreviewHtml(invoice(), { contactNumber: '1234567890' }, []), /Sandipbhai \(1234567890\)/);
  assert.doesNotMatch(html, /<dt>Status<\/dt>|Payment Status|Partially Paid|Amount Paid|Balance Due|UPI-123|Thank you for your business|Electronically generated invoice/);
  assert.doesNotMatch(html, /sabha|9876543210.*sabha/i);
  assert.doesNotMatch(invoicePreviewHtml(invoice(), {}, []), /FSSAI License No\./);
  assert.equal(invoicePdfModel(invoice('unpaid', 0), {}, []).status, 'Unpaid');
  assert.equal(invoicePdfModel(invoice('paid', 120000), {}, [{ amountPaise: 120000, verificationStatus: 'verified', mode: 'cash' }]).status, 'Paid');
  assert.equal(invoicePdfModel(invoice('ready_to_mark_paid', 120000), {}, [{ amountPaise: 120000, verificationStatus: 'verified', mode: 'cash' }]).status, 'Paid');
  assert.equal(invoicePdfModel(invoice('in_process', 0), {}, [pending]).status, 'Payment in process');
  assert.throws(() => invoicePdfModel(invoice('partial', 40000), {}, [pending]), /reconciled/);
  assert.ok(readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8').includes('body>:not(#invoice-preview-dialog)'));
});

test('downloaded PDF matches the clean invoice layout and supports multiple pages', async () => {
  const original = { window: globalThis.window, document: globalThis.document, Image: globalThis.Image, FontFace: globalThis.FontFace, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  const drawn = [];
  let alignment;
  const headerAlignments = [];
  const ctx = { scale() {}, fillRect() {}, drawImage(image) { drawn.push(image.source?.includes('invoice-blessing.png') ? 'blessing' : 'logo'); }, fillText(value) { drawn.push(String(value)); if (['INVOICE', 'SUHRAD SWEETS', 'Sweetness to Share, Quality with Care'].includes(value) || String(value).startsWith('Contact :')) headerAlignments.push(alignment); }, measureText(value) { return { width: String(value).length * 6 }; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set fillStyle(_) {}, set font(_) {}, set textAlign(value) { alignment = value; }, set strokeStyle(_) {} };
  let pages = 0;
  const downloads = [];
  try {
    globalThis.window = { PDFLib: { PDFDocument: { create: async () => ({ addPage() { pages++; return { drawImage() {} }; }, embedPng: async () => ({}), save: async () => new Uint8Array([1]) }) } } };
    globalThis.Image = class { set src(value) { this.source = value; queueMicrotask(() => this.onload()); } };
    globalThis.FontFace = class { async load() { return this; } };
    globalThis.document = { fonts: { add() {} }, createElement(tag) { return tag === 'canvas' ? { getContext: () => ctx, toDataURL: () => 'data:image/png;base64,' } : { click() { downloads.push(this.download); } }; } };
    URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
    const many = invoice(); many.lines = Array.from({ length: 13 }, (_, index) => ({ ...many.lines[0], description: `Historical line ${index}` }));
    await downloadInvoicePdf(many, { fssaiLicenseNo: '00123456789012' });
    assert.equal(downloads[0], 'Asha_INV-SS-1.pdf');
    assert.equal(pages, 2);
    assert.equal(drawn.filter((value) => value === 'logo').length, 2);
    assert.equal(drawn.filter((value) => value === 'blessing').length, 2);
    assert.deepEqual(headerAlignments, Array(8).fill('right'));
    assert.equal(drawn.filter((value) => value === 'SUHRAD SWEETS').length, 2);
    assert.equal(drawn.filter((value) => value === 'Sweetness to Share, Quality with Care').length, 2);
    assert.equal(drawn.filter((value) => value.includes('Sandipbhai (9558350540)')).length, 2);
    assert.equal(drawn.filter((value) => value === 'GRAND TOTAL').length, 1);
    assert.equal(drawn.filter((value) => value === 'Rupees One Thousand Two Hundred Only.').length, 1);
    assert.equal(drawn.filter((value) => value === 'Thank You for Your Order!').length, 1);
    assert.equal(drawn.filter((value) => value === 'FSSAI License No.').length, 2);
    assert.equal(drawn.filter((value) => value === '00123456789012').length, 2);
    assert.equal(drawn.filter((value) => value === 'This is a computer-generated invoice and does not require a signature.').length, 1);
    assert.equal(drawn.some((value) => /^(Status|Paid|Unpaid|Partially Paid|Payment in process)$|Payment Status|Amount Paid|Balance Due/.test(value)), false);
    assert.equal(drawn.some((value) => /Thank you for your business|Electronically generated invoice|Other Charges|Tax \/ GST/.test(value)), false);
    drawn.length = 0;
    await downloadInvoicePdf(invoice('partial', 40000), {}, [{ amountPaise: 40000, verificationStatus: 'verified', mode: 'upi', transactionNumber: 'UPI-123' }]);
    assert.equal(downloads[1], 'Asha_INV-SS-1.pdf');
    assert.equal(drawn.some((value) => value.includes('FSSAI License No.')), false);
    assert.equal(drawn.some((value) => value.includes('UPI-123')), false);
    for (const count of [1, 5, 10]) {
      const varied = invoice();
      varied.customerSnapshot.fullName = 'A very long customer name that must fit within the invoice bill to panel';
      varied.lines = Array.from({ length: count }, (_, index) => ({ ...varied.lines[0], description: `Long item description for invoice row ${index + 1} with additional detail` }));
      varied.totalPaise = 123456789;
      varied.subtotal = 123456789;
      const before = pages;
      await downloadInvoicePdf(varied);
      assert.equal(pages - before, Math.ceil(count / 9));
    }
  } finally {
    globalThis.window = original.window; globalThis.document = original.document; globalThis.Image = original.Image; globalThis.FontFace = original.FontFace;
    URL.createObjectURL = original.createObjectURL; URL.revokeObjectURL = original.revokeObjectURL;
  }
});
