import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { previewAmountWords, previewFilename, previewInvoice, previewProductLine, previewTotal, previewUnits, validatePreview } from '../js/invoice-preview-model.js';

test('Special Item preview saves only preview data and retains its price until refresh', async () => {
  const nodes = new Map(), events = new Map(), writes = [];
  const fields = Object.fromEntries(['fullName', 'contact', 'area', 'address'].map((key) => [key, { value: key === 'fullName' ? 'Mukesh Patel' : '' }]));
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: false, disabled: false, innerHTML: '', textContent: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, scrollIntoView() {}, reset() {}, elements: { namedItem: (name) => fields[name] } });
    return nodes.get(id);
  };
  const product = { id: 'specialA', name: 'Festival Combo', active: true, finalPricePaise: 27500 };
  let saved;
  const context = {
    document: { getElementById: node, addEventListener: (name, listener) => events.set(name, listener) },
    canAccessPage: () => true, isStaff: () => true,
    listOrderProducts: async (_db, type) => type === 'specialProducts' ? [product] : [{ id: 'sweetA', name: 'Sweet', active: true, defaultSellingPrice: 100 }],
    getDocs: async () => ({ docs: saved ? [{ id: 'previewA', data: () => saved }] : [] }),
    readBusinessDetails: async () => ({}), collection: (_db, name) => name, query: () => ({}), where: () => ({}),
    doc: (_db, collectionName, id) => `${collectionName}/${id}`,
    setDoc: async (path, data) => { writes.push(path); saved = { ...data }; },
    getDoc: async () => ({ data: () => saved }), serverTimestamp: () => new Date('2026-11-05'),
    previewAmountWords, previewFilename, previewInvoice, previewProductLine, previewTotal, previewUnits, validatePreview,
    uniqueId: () => 'previewA', createInvoicePdfBlob: async () => new Blob(), invoicePreviewHtml: () => '', sharePreviewPdf: async () => 'shared',
  };
  const source = readFileSync(new URL('../js/invoice-preview-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initInvoicePreviewUi', 'function initInvoicePreviewUi');
  vm.runInNewContext(`${source}\nthis.init = initInvoicePreviewUi;`, context);
  context.init({ db: {} }).setSession({ uid: 'userA' }, { role: 'admin' });
  events.get('oms:pagechange')({ detail: { page: 'invoicePreviews' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  node('invoice-preview-add-special').listeners.click();
  assert.match(node('invoice-preview-lines').innerHTML, /Festival Combo[\s\S]*Combo/);
  assert.match(node('invoice-preview-lines').innerHTML, /Special Items/);
  await node('invoice-preview-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(writes, ['invoicePreviews/previewA']);
  assert.equal(saved.lines[0].kind, 'special');
  assert.equal(saved.lines[0].unitPricePaise, 27500);
  product.finalPricePaise = 30000;
  await node('invoice-preview-history').listeners.click({ target: { closest: () => ({ dataset: { editPreview: 'previewA' } }) } });
  assert.match(node('invoice-preview-lines').innerHTML, /275\.00/);
  node('invoice-preview-refresh').listeners.click();
  assert.match(node('invoice-preview-lines').innerHTML, /300\.00/);
  assert.equal(saved.lines[0].unitPricePaise, 27500, 'refresh does not overwrite the saved preview before Save');
});
