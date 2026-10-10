import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('purchase form, loading, search and export have no item dependency', async () => {
  const elements = new Map(), reads = [], writes = [], exports = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() {}, close() {} });
    return elements.get(id);
  };
  const values = { supplierName: 'Supplier', purchaseDate: '2026-10-10', purchaseTypeId: 'type', total: '250.50', paid: '100', paymentMode: 'upi', paymentReference: 'REF001', notes: '', documentUrl: '' };
  const context = {
    document: { getElementById: element, addEventListener() {}, querySelector: () => null },
    isStaff: profile => profile?.role === 'admin', showToast() {},
    listPurchases: async () => [{ id: 'legacy', supplierName: 'Supplier', purchaseDate: '2026-10-10', purchaseTypeSnapshot: 'Donation', totalPaise: 25050, status: 'draft', lines: [{ itemSnapshot: { name: 'Old item' } }] }],
    listMasterRecords: async (_db, type) => { reads.push(type); assert.equal(type, 'purchaseTypes'); return [{ id: 'type', name: 'Donation', active: true }]; },
    callOperation: async (_fn, name, payload) => { writes.push({ name, payload }); },
    downloadXlsx: async (_name, sheets) => { exports.push(sheets); },
    FormData: class { get(key) { return values[key]; } },
  };
  const source = readFileSync(new URL('../js/operations-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOperationsUi', 'function initOperationsUi');
  vm.runInNewContext(`${source}\nthis.init = initOperationsUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin' });
  await element('purchase-refresh').listeners.click();
  assert.deepEqual(reads, ['purchaseTypes']);
  element('purchase-new').listeners.click();
  assert.match(element('ops-fields').innerHTML, /name="total"/);
  assert.doesNotMatch(element('ops-fields').innerHTML, /itemId|ops-lines|Add line|Unit cost|Quantity/);
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(writes[0].name, 'savePurchaseDraft');
  assert.equal(writes[0].payload.totalPaise, 25050);
  assert.equal(writes[0].payload.paidAmountPaise, 10000);
  assert.equal(writes[0].payload.lines, undefined);
  element('purchase-search').value = 'donation'; element('purchase-search').listeners.input();
  assert.match(element('purchase-body').innerHTML, /Supplier/);
  await element('purchase-export').listeners.click();
  assert.equal(exports[0].length, 1);
  assert.equal(exports[0][0][0], 'Purchases');
  assert.equal(exports[0][0][1][0].TotalRupees, 250.5);
});
