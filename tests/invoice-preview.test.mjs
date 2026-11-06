import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFilename, previewInvoice, previewPrice, previewProductLine, previewTotal, previewUnits, validatePreview } from '../js/invoice-preview-model.js';
import { createInvoicePdfBlob, invoicePdfModel, invoicePreviewHtml } from '../js/invoice-pdf.js';
import { previewWhatsappPhone, sharePreviewPdf } from '../js/invoice-preview-share.js';

const gift = { id: 'gift', name: 'Gift Packing', defaultSellingPrice: 25 };
const sweet = { id: 'sweet', name: 'Kaju', defaultSellingPrice: 100, sellingPrice500Gm: 60 };
const special = { id: 'specialA', name: 'Festival Combo', finalPricePaise: 27500, active: true };
const line = (quantityQty = 1000) => ({ productId: 'sweet', description: 'Kaju', unitId: 'kg', unit: 'KG', quantityQty, unitPricePaise: 10000, lineTotalPaise: previewTotal(quantityQty, 10000) });
const preview = (lines = [line()]) => validatePreview({ customerSnapshot: { fullName: 'Mukesh Patel', contact: '', area: '', address: '' }, lines });

test('new preview lines use current order prices and Gift Packing PCS only', () => {
  assert.deepEqual(previewUnits(gift, 'user').map((unit) => unit.id), ['pcs']);
  assert.deepEqual(previewUnits(sweet, 'user').map((unit) => unit.id), ['kg', '500gm']);
  assert.equal(previewPrice(gift, 'pcs'), 2500);
  assert.throws(() => previewPrice(gift, 'kg'), /selected unit/);
  assert.equal(previewPrice(sweet, '500gm'), 6000);
  assert.equal(previewTotal(2000, 6000), 12000);
});

test('one and multiple saved lines retain prices and calculate totals', () => {
  assert.equal(preview().totalPaise, 10000);
  const multi = preview([line(), { ...line(2000), productId: 'gift', description: 'Gift Packing', unitId: 'pcs', unit: 'PCS', unitPricePaise: 2500, lineTotalPaise: 5000 }]);
  assert.equal(multi.totalPaise, 15000);
  assert.equal(multi.lines[0].unitPricePaise, 10000);
  assert.throws(() => preview([{ ...line(), lineTotalPaise: 1 }]), /line total/);
});

test('Special Items use the order combo price and work alone or with regular items', () => {
  assert.deepEqual(previewUnits(special, 'user', 'special'), [{ id: 'combo', label: 'Combo' }]);
  assert.equal(previewPrice(special, 'combo', 'special'), 27500);
  assert.throws(() => previewPrice(special, 'kg', 'special'), /selected unit/);
  const specialLine = previewProductLine(special, 'special', 'combo', 2000);
  assert.deepEqual({ kind: specialLine.kind, unit: specialLine.unit, quantityQty: specialLine.quantityQty, lineTotalPaise: specialLine.lineTotalPaise }, { kind: 'special', unit: 'Combo', quantityQty: 2000, lineTotalPaise: 55000 });
  assert.equal(preview([specialLine]).totalPaise, 55000);
  assert.equal(preview([line(), specialLine]).totalPaise, 65000);
});

test('saved Special Item snapshots retain price until current prices are requested', () => {
  const saved = previewProductLine(special, 'special', 'combo');
  const updatedMaster = { ...special, finalPricePaise: 30000 };
  assert.equal(preview([{ ...saved }]).lines[0].unitPricePaise, 27500);
  const refreshed = previewProductLine(updatedMaster, 'special', saved.unitId, saved.quantityQty);
  assert.equal(refreshed.unitPricePaise, 30000);
  assert.equal(preview([refreshed]).totalPaise, 30000);
  const html = invoicePreviewHtml(previewInvoice({ ...preview([saved]), reference: 'PREV-SPECIAL' }));
  assert.match(html, /Festival Combo/);
  assert.match(html, /Combo/);
  assert.match(html, /275\.00/);
});

test('PDF is marked preview, uses a separate reference and customer filename', () => {
  const record = { ...preview(), reference: 'PREV-ABC123', updatedAt: '2026-11-05' };
  const invoice = previewInvoice(record);
  const model = invoicePdfModel(invoice);
  assert.equal(model.documentType, 'preview');
  assert.equal(model.invoiceNumber, 'PREV-ABC123');
  assert.match(invoicePreviewHtml(invoice), /INVOICE PREVIEW/);
  assert.match(invoicePreviewHtml(invoice), /not a tax invoice/);
  assert.equal(previewFilename(record), 'Mukesh Patel - Invoice Preview - PREV-ABC123.pdf');
  assert.notEqual(previewFilename({ ...record, reference: 'PREV-XYZ' }), previewFilename(record));
  assert.equal(previewFilename({ ...record, customerSnapshot: { fullName: 'Mukesh / Patel:*?' } }), 'Mukesh Patel - Invoice Preview - PREV-ABC123.pdf');
});

test('mobile file sharing includes PDF; desktop fallback downloads and opens WhatsApp', async () => {
  const record = { ...preview(), reference: 'PREV-ABC123', customerSnapshot: { fullName: 'Mukesh Patel', contact: '9876543210' } };
  const blob = new Blob(['pdf'], { type: 'application/pdf' });
  const calls = [];
  class FileStub { constructor(parts, name) { this.name = name; this.parts = parts; } }
  assert.equal(await sharePreviewPdf(record, blob, 'preview.pdf', { browserNavigator: { canShare: () => true, share: async (payload) => calls.push(payload) }, FileType: FileStub, download: () => { throw new Error('Unexpected download'); } }), 'shared');
  assert.equal(calls[0].files[0].name, 'preview.pdf');
  assert.equal(previewWhatsappPhone('9876543210'), '919876543210');
  assert.equal(await sharePreviewPdf(record, blob, 'preview.pdf', { browserNavigator: {}, FileType: FileStub, download: (_blob, name) => calls.push(name), open: (url) => { calls.push(url); return {}; } }), 'manual');
  assert.equal(calls[1], 'preview.pdf');
  assert.match(calls[2], /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.match(decodeURIComponent(calls[2]), /I will attach the downloaded PDF here/);
});

test('generated PDF pages carry the preview marking', async () => {
  const prior = { window: globalThis.window, document: globalThis.document, Image: globalThis.Image };
  const labels = [];
  try {
    globalThis.window = { PDFLib: { PDFDocument: { create: async () => ({ addPage: () => ({ drawImage() {} }), embedPng: async () => ({}), save: async () => new Uint8Array([1]) }) } } };
    globalThis.Image = class { set src(_value) { queueMicrotask(() => this.onload()); } };
    globalThis.document = { createElement: () => ({ getContext: () => ({ scale() {}, fillRect() {}, drawImage() {}, fillText(value) { labels.push(String(value)); }, measureText: (value) => ({ width: String(value).length * 5 }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set strokeStyle(_) {} }), toDataURL: () => 'data:image/png;base64,' }) };
    const blob = await createInvoicePdfBlob(previewInvoice({ ...preview([previewProductLine(special, 'special', 'combo')]), reference: 'PREV-ABC123' }));
    assert.equal(blob.type, 'application/pdf');
    assert.ok(labels.includes('INVOICE PREVIEW'));
    assert.ok(labels.includes('For customer review only'));
    assert.ok(labels.includes('PREV-ABC123'));
    assert.ok(labels.some((value) => value.includes('Festival Combo')));
  } finally { globalThis.window = prior.window; globalThis.document = prior.document; globalThis.Image = prior.Image; }
});
