import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invoicePdfModel, invoicePreviewHtml, downloadInvoicePdf } from '../js/invoice-pdf.js';
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

test('preview uses snapshots, safe business details and verified payments only', () => {
  const payment = { amountPaise: 40000, verificationStatus: 'verified', mode: 'upi', transactionNumber: 'UPI-123' };
  const pending = { amountPaise: 80000, verificationStatus: 'unverified', mode: 'cash' };
  const model = invoicePdfModel(invoice('in_process', 40000), { fssaiLicenseNo: '00123456789012' }, [payment, pending]);
  assert.equal(model.status, 'Partially Paid'); assert.equal(model.balanceDuePaise, 80000);
  assert.equal(model.verifiedPayments.length, 1); assert.equal(model.lines[1].description, 'Gift Box');
  const html = invoicePreviewHtml(invoice('in_process', 40000), { fssaiLicenseNo: '00123456789012' }, [payment, pending]);
  for (const text of ['FSSAI License No.: 00123456789012', 'Asha', 'INV-SS-1', 'SS-1', 'Kaju Katli', 'Gift Box', '₹1,200.00', '₹400.00', '₹800.00', 'UPI-123']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /sabha|9876543210.*sabha/i);
  assert.doesNotMatch(invoicePreviewHtml(invoice(), {}, []), /FSSAI License No\./);
  assert.equal(invoicePdfModel(invoice('unpaid', 0), {}, []).status, 'Unpaid');
  assert.equal(invoicePdfModel(invoice('paid', 120000), {}, [{ amountPaise: 120000, verificationStatus: 'verified', mode: 'cash' }]).status, 'Paid');
  assert.equal(invoicePdfModel(invoice('ready_to_mark_paid', 120000), {}, [{ amountPaise: 120000, verificationStatus: 'verified', mode: 'cash' }]).status, 'Awaiting final approval');
  assert.equal(invoicePdfModel(invoice('in_process', 0), {}, [pending]).status, 'Payment in process');
  assert.throws(() => invoicePdfModel(invoice('partial', 40000), {}, [pending]), /reconciled/);
  assert.ok(readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8').includes('body>:not(#invoice-preview-dialog)'));
});

test('downloaded PDF draws FSSAI, logo and multiple pages', async () => {
  const original = { window: globalThis.window, document: globalThis.document, Image: globalThis.Image, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  const drawn = [];
  const ctx = { scale() {}, fillRect() {}, drawImage() { drawn.push('logo'); }, fillText(value) { drawn.push(String(value)); }, measureText(value) { return { width: String(value).length * 6 }; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set strokeStyle(_) {} };
  let pages = 0;
  try {
    globalThis.window = { PDFLib: { PDFDocument: { create: async () => ({ addPage() { pages++; return { drawImage() {} }; }, embedPng: async () => ({}), save: async () => new Uint8Array([1]) }) } } };
    globalThis.Image = class { set src(_) { queueMicrotask(() => this.onload()); } };
    globalThis.document = { createElement(tag) { return tag === 'canvas' ? { getContext: () => ctx, toDataURL: () => 'data:image/png;base64,' } : { click() {} }; } };
    URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
    const many = invoice(); many.lines = Array.from({ length: 13 }, (_, index) => ({ ...many.lines[0], description: `Historical line ${index}` }));
    await downloadInvoicePdf(many, { fssaiLicenseNo: '00123456789012' });
    assert.equal(pages, 2);
    assert.equal(drawn.filter((value) => value === 'logo').length, 2);
    assert.equal(drawn.filter((value) => value === 'FSSAI License No.: 00123456789012').length, 2);
    assert.ok(drawn.includes('Balance Due'));
    drawn.length = 0;
    await downloadInvoicePdf(invoice('partial', 40000), {}, [{ amountPaise: 40000, verificationStatus: 'verified', mode: 'upi', transactionNumber: 'UPI-123' }]);
    assert.equal(drawn.some((value) => value.includes('FSSAI License No.')), false);
    assert.ok(drawn.some((value) => value.includes('UPI-123')));
  } finally {
    globalThis.window = original.window; globalThis.document = original.document; globalThis.Image = original.Image;
    URL.createObjectURL = original.createObjectURL; URL.revokeObjectURL = original.revokeObjectURL;
  }
});
