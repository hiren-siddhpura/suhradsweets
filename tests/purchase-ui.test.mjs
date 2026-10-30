import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateAttachmentFile } from '../js/attachment-validation.js';
import { validatePurchaseAttachment, readPurchaseReceipt } from '../functions/operations.js';

test('purchase file validation accepts JPG/JPEG/PNG/PDF through 5 MB and rejects invalid uploads', () => {
  for (const [name, type, extension] of [['bill.JPG', 'image/jpeg', 'jpg'], ['bill.jpeg', 'image/jpeg', 'jpg'], ['bill.png', 'image/png', 'png'], ['bill.pdf', 'application/pdf', 'pdf']]) {
    assert.equal(validateAttachmentFile({ name, type, size: 5 * 1024 * 1024 }), extension);
    assert.throws(() => validateAttachmentFile({ name, type, size: 5 * 1024 * 1024 + 1 }), /exceeds 5 MB/);
  }
  assert.throws(() => validateAttachmentFile({ name: 'bill.pdf', type: 'application/pdf', size: 0 }), /empty/);
  assert.throws(() => validateAttachmentFile({ name: 'bill.exe', type: 'application/pdf', size: 10 }), /JPG/);
  assert.throws(() => validateAttachmentFile({ name: 'bill.svg', type: 'image/svg+xml', size: 10 }), /JPG/);
});

test('trusted purchase validation checks actual bytes, MIME, ownership and size', () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024); bytes.write('%PDF-');
  const metadata = { size: bytes.length, contentType: 'application/pdf', metadata: { originalName: 'bill.pdf', ownerUid: 'staff', purchaseId: 'purchase' } };
  assert.equal(validatePurchaseAttachment(bytes, metadata, 'staff', 'purchase', 'pdf').size, bytes.length);
  assert.throws(() => validatePurchaseAttachment(bytes, { ...metadata, size: bytes.length + 1 }, 'staff', 'purchase', 'pdf'), /5 MB/);
  assert.throws(() => validatePurchaseAttachment(Buffer.from('wrong'), { ...metadata, size: 5 }, 'staff', 'purchase', 'pdf'), /valid JPG/);
  assert.throws(() => validatePurchaseAttachment(bytes, metadata, 'other', 'purchase', 'pdf'), /belong/);
  assert.throws(() => validatePurchaseAttachment(bytes, metadata, 'staff', 'other', 'pdf'), /belong/);
  assert.throws(() => validatePurchaseAttachment(bytes, metadata, 'staff', 'purchase', 'jpg'), /valid JPG/);
});

test('purchase attachments cannot be read by ordinary or inactive users', async () => {
  for (const profile of [{ role: 'user', active: true }, { role: 'admin', active: false }]) {
    const db = { doc: (path) => { assert.equal(path, 'users/viewer'); return { get: async () => ({ exists: true, data: () => profile }) }; } };
    await assert.rejects(readPurchaseReceipt(db, 'viewer', { purchaseId: 'purchase' }), /access is required/);
  }
});

test('Purchases uses the OMS loader while records load and releases it on failure', async () => {
  const nodes = new Map(), active = new Set();
  let rejectRead;
  const el = id => { if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }); return nodes.get(id); };
  const context = {
    document: { getElementById: el, addEventListener() {}, querySelector: () => null },
    isStaff: () => true, showToast() {}, console: { error() {} },
    listPurchases: () => new Promise((_, reject) => { rejectRead = reject; }),
    listMasterRecords: async () => [],
    omsLoading: { start() { const token = Symbol(); active.add(token); return token; }, stop(token) { active.delete(token); } },
  };
  const source = readFileSync(new URL('../js/operations-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOperationsUi', 'function initOperationsUi');
  vm.runInNewContext(`${source}\nthis.init = initOperationsUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin' });
  const load = el('purchase-refresh').listeners.click();
  assert.equal(active.size, 1);
  assert.equal(el('purchase-message').textContent, '');
  rejectRead(new Error('offline'));
  await load;
  assert.equal(active.size, 0);
  assert.match(el('purchase-message').textContent, /offline/);
});

test('purchase form, loading, search and export have no item dependency', async () => {
  const elements = new Map(), reads = [], writes = [], exports = [], uploads = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() {}, close() {} });
    return elements.get(id);
  };
  const values = { quantity: ' 2.5 ', unit: ' boxes ', supplierName: 'Supplier', purchaseDate: '2026-10-10', purchaseTypeId: 'type', total: '250.50', paid: '100', paymentMode: 'upi', paymentReference: 'REF001', notes: '', documentUrl: '' };
  const context = {
    document: { getElementById: element, addEventListener() {}, querySelector: () => null },
    isStaff: profile => profile?.role === 'admin', showToast() {},
    listPurchases: async () => [{ id: 'legacy', supplierName: 'Supplier', purchaseDate: '2026-10-10', purchaseTypeSnapshot: 'Donation', totalPaise: 25050, status: 'draft', lines: [{ itemSnapshot: { name: 'Old item' } }] }, {id:'new',supplierName:'Decimal Supplier',purchaseDate:'2026-10-10',quantity:'2.5',unit:'boxes',purchaseTypeSnapshot:'Donation',totalPaise:25050,status:'draft'}],
    listMasterRecords: async (_db, type) => { reads.push(type); assert.equal(type, 'purchaseTypes'); return [{ id: 'type', name: 'Donation', active: true }]; },
    callOperation: async (_fn, name, payload) => { writes.push({ name, payload }); },
    downloadXlsx: async (_name, sheets) => { exports.push(sheets); },
    validateAttachmentFile, uniqueId: () => 'upload-id', getStorage: () => ({}), storageRef: (_, path) => path,
    uploadBytesResumable: (path, file, metadata) => { uploads.push({ path, file, metadata }); return { on: (_, progress, reject, resolve) => { progress({ bytesTransferred: file.size, totalBytes: file.size }); resolve(); } }; },
    FormData: class { get(key) { return values[key]; } },
  };
  const source = readFileSync(new URL('../js/operations-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOperationsUi', 'function initOperationsUi');
  vm.runInNewContext(`${source}\nthis.init = initOperationsUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin' });
  await element('purchase-refresh').listeners.click();
  assert.deepEqual(reads, ['purchaseTypes']);
  element('purchase-new').listeners.click();
  assert.match(element('ops-fields').innerHTML, /name="total"/);
  assert.match(element('ops-fields').innerHTML, /class="purchase-measure-fields"/);
  assert.match(element('ops-fields').innerHTML, /name="quantity" type="text"/);
  assert.match(element('ops-fields').innerHTML, /name="unit" type="text"/);
  assert.doesNotMatch(element('ops-fields').innerHTML, /itemId|ops-lines|Add line|Unit cost/);
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(writes[0].name, 'savePurchaseDraft');
  assert.equal(writes[0].payload.quantity, '2.5');
  assert.equal(writes[0].payload.unit, 'boxes');
  assert.match(element('purchase-body').innerHTML, /Not recorded/);
  assert.equal(writes[0].payload.totalPaise, 25050);
  assert.equal(writes[0].payload.paidAmountPaise, 10000);
  assert.equal(writes[0].payload.lines, undefined);
  element('purchase-search').value = 'donation'; element('purchase-search').listeners.input();
  assert.match(element('purchase-body').innerHTML, /Supplier/);
  await element('purchase-export').listeners.click();
  assert.equal(exports[0].length, 1);
  assert.equal(exports[0][0][0], 'Purchases');
  assert.equal(exports[0][0][1][0].Quantity, 'Not recorded');
  assert.equal(exports[0][0][1][0].Unit, 'Not recorded');
  assert.equal(exports[0][0][1][0].TotalRupees, 250.5);
  assert.equal(exports[0][0][1][1].Quantity, '2.5');
  assert.equal(exports[0][0][1][1].Unit, 'boxes');
  element('purchase-search').value = '2.5'; element('purchase-search').listeners.input();
  assert.match(element('purchase-body').innerHTML, /Decimal Supplier/);
  assert.doesNotMatch(element('purchase-body').innerHTML, /Old item|data-id="legacy"/);
  assert.match(element('purchase-body').innerHTML, /<td>2\.5<\/td><td>boxes<\/td>/);
  element('purchase-search').value = 'boxes'; element('purchase-search').listeners.input();
  assert.match(element('purchase-body').innerHTML, /Decimal Supplier/);
  values.quantity = '0'; await element('ops-form').listeners.submit({preventDefault(){},currentTarget:{}});
  assert.match(element('ops-error').textContent, /greater than zero/);
  assert.equal(writes.length, 1);
  values.quantity = '1';
  values.attachment = { name: 'bill.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 + 1 };
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.match(element('ops-error').textContent, /exceeds 5 MB/);
  assert.equal(uploads.length, 0);
  assert.equal(writes.length, 1);
  values.attachment = { name: 'bill.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 };
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, 'purchaseReceipts/admin/upload-id/upload-id.pdf');
  assert.equal(writes[1].payload.attachment.extension, 'pdf');
  assert.equal(writes[1].payload.purchaseId, 'upload-id');
});
