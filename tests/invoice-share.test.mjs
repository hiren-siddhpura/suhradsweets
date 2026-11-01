import test from 'node:test';
import assert from 'node:assert/strict';
import { shareInvoicePdf, whatsappPhone } from '../js/invoice-share.js';
import { invoicePdfFilename } from '../js/invoice-filename.js';

const invoice = { invoiceNumber: 'INV-1', totalPaise: 120000, customerSnapshot: { contact: '98765 43210', countryCode: '+91' } };

test('invoice filenames preserve Unicode names and sanitize filesystem characters', () => {
  assert.equal(invoicePdfFilename({ invoiceNumber: 'INV-SS-2026-000004', customerSnapshot: { fullName: ' Sandip  Pawar ' } }), 'Sandip_Pawar_INV-SS-2026-000004.pdf');
  assert.equal(invoicePdfFilename({ invoiceNumber: 'INV-1', customerSnapshot: { fullName: 'સંદીપ પવાર' } }), 'સંદીપ_પવાર_INV-1.pdf');
  assert.equal(invoicePdfFilename({ invoiceNumber: 'INV/1', customerSnapshot: { fullName: 'A/B\\C:*?"<>|' } }), 'A_B_C_INV_1.pdf');
  assert.equal(invoicePdfFilename(invoice), 'INV-1.pdf');
});

test('WhatsApp numbers require an explicit international prefix or stored country code', () => {
  assert.equal(whatsappPhone(invoice.customerSnapshot), '919876543210');
  assert.equal(whatsappPhone({ contact: '+44 (7700) 900123' }), '447700900123');
  assert.equal(whatsappPhone({ contact: '0044 7700 900123' }), '447700900123');
  for (const contact of ['9876543210', '123', 'abc', '+01234567890', '0919876543210']) assert.equal(whatsappPhone({ contact }), null);
  assert.equal(whatsappPhone({ contact: '9876543210', countryCode: '91x' }), null);
});

test('file sharing uses the invoice PDF and respects cancellation', async () => {
  const originalFile = globalThis.File;
  const blob = new Blob(['pdf'], { type: 'application/pdf' });
  let shared;
  try {
    globalThis.File = class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } };
    const browserNavigator = { canShare: ({ files }) => files[0].type === 'application/pdf', share: async (data) => { shared = data; } };
    const namedInvoice = { ...invoice, customerSnapshot: { ...invoice.customerSnapshot, fullName: 'Sandip Pawar' } };
    assert.equal(await shareInvoicePdf(namedInvoice, blob, { navigator: browserNavigator, download: () => { throw Error('downloaded'); } }), 'shared');
    assert.equal(shared.files[0].name, 'Sandip_Pawar_INV-1.pdf');
    assert.equal(shared.files[0].parts[0], blob);
    browserNavigator.share = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
    assert.equal(await shareInvoicePdf(invoice, blob, { navigator: browserNavigator, download: () => { throw Error('downloaded'); } }), 'cancelled');
  } finally { globalThis.File = originalFile; }
});

test('unsupported file sharing downloads PDF and opens only a verified customer chat', async () => {
  const blob = new Blob(['pdf'], { type: 'application/pdf' });
  let filename, url;
  assert.equal(await shareInvoicePdf(invoice, blob, { navigator: {}, download: (_, name) => { filename = name; }, open: (value) => { url = value; return {}; } }), 'whatsapp');
  assert.equal(filename, 'INV-1.pdf');
  assert.equal(await shareInvoicePdf({ ...invoice, customerSnapshot: { ...invoice.customerSnapshot, fullName: 'સંદીપ પવાર' } }, blob, { navigator: {}, download: (_, name) => { filename = name; }, open: () => ({}) }), 'whatsapp');
  assert.equal(filename, 'સંદીપ_પવાર_INV-1.pdf');
  assert.match(url, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.match(decodeURIComponent(url), /Invoice INV-1 · Total ₹1,200.00/);
  url = undefined;
  assert.equal(await shareInvoicePdf({ ...invoice, customerSnapshot: { contact: '9876543210' } }, blob, { navigator: {}, download: () => {}, open: (value) => { url = value; } }), 'manual');
  assert.equal(url, undefined);
});
