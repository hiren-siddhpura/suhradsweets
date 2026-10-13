import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('inventory cards, four statuses, actions, history and absolute count use Firestore results', async () => {
  const elements = new Map(), calls = [], exports = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() {}, close() {}, scrollIntoView() {} });
    return elements.get(id);
  };
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `Sweet ${id}`, itemCode: `SKU-${id}`, defaultUnitId: 'kg' }));
  const stocks = [
    { id: 'a', onHandQty: 5000, reservedQty: 0, lowStockThresholdQty: 1000, sellingBlocked: false },
    { id: 'b', onHandQty: 500, reservedQty: 0, lowStockThresholdQty: 1000, sellingBlocked: false },
    { id: 'c', onHandQty: 0, reservedQty: 0, lowStockThresholdQty: 1000, sellingBlocked: false },
    { id: 'd', onHandQty: 9000, reservedQty: 0, lowStockThresholdQty: 1000, sellingBlocked: true },
  ];
  const values = { counted: '7.25', reason: 'Physical count' };
  const context = {
    document: { getElementById: element, addEventListener() {}, querySelector: () => null },
    crypto: { randomUUID: () => 'count-1' },
    isStaff: (profile) => profile?.role === 'admin', showToast() {},
    listPurchases: async () => [], listInventory: async () => stocks,
    listMovements: async () => [{ itemId: 'a', itemSnapshot: { name: 'Sweet a', itemCode: 'SKU-a', unitSymbol: 'kg' }, previousQty: 6000, changeQty: -1000, newQty: 5000, reason: 'Order confirmed', actorName: 'Admin' }],
    listMasterRecords: async (_db, type) => type === 'items' ? items : type === 'units' ? [{ id: 'kg', symbol: 'kg' }] : [],
    callOperation: async (_functions, name, payload) => { calls.push({ name, payload }); },
    downloadXlsx: async (_name, sheets) => { exports.push(sheets); },
    FormData: class { get(key) { return values[key]; } },
  };
  const source = readFileSync(new URL('../js/operations-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOperationsUi', 'function initOperationsUi');
  vm.runInNewContext(`${source}\nthis.init = initOperationsUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'adminA' }, { role: 'admin' });
  await element('inventory-refresh').listeners.click();
  assert.match(element('inventory-cards').innerHTML, /Total items<\/span><strong>4/);
  assert.match(element('inventory-cards').innerHTML, /Low-stock items<\/span><strong>1/);
  assert.match(element('inventory-cards').innerHTML, /Out-of-stock items<\/span><strong>1/);
  assert.match(element('inventory-cards').innerHTML, /Blocked items<\/span><strong>1/);
  assert.match(element('inventory-body').innerHTML, /SKU-a/);
  assert.match(element('inventory-body').innerHTML, /5 kg/);
  assert.match(element('inventory-mobile-list').innerHTML, /Sweet d/);
  element('inventory-status').value = 'blocked'; element('inventory-status').listeners.input();
  assert.match(element('inventory-body').innerHTML, /Sweet d/);
  assert.doesNotMatch(element('inventory-body').innerHTML, /Sweet a/);
  element('inventory-status').value = ''; element('inventory-status').listeners.input();
  element('inventory-body').listeners.click({ target: { closest: () => ({ dataset: { op: 'adjust', id: 'a' } }) } });
  assert.match(element('ops-fields').innerHTML, /Current stock: 5 kg/);
  assert.match(element('ops-fields').innerHTML, /Counted physical quantity/);
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(calls[0].name, 'adjustStock');
  assert.equal(calls[0].payload.countedQty, 7250);
  assert.equal(calls[0].payload.expectedOnHandQty, 5000);
  assert.equal(calls[0].payload.operationId, 'count-1');
  element('inventory-body').listeners.click({ target: { closest: () => ({ dataset: { op: 'block', id: 'a' } }) } });
  assert.match(element('ops-fields').innerHTML, /Reason for blocking/);
  await element('ops-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(calls[1].name, 'setInventoryControl');
  assert.equal(calls[1].payload.sellingBlocked, true);
  element('inventory-body').listeners.click({ target: { closest: () => ({ dataset: { op: 'history', id: 'a' } }) } });
  assert.equal(element('inventory-item').value, 'a');
  assert.match(element('movement-body').innerHTML, /Admin/);
  await element('inventory-export').listeners.click();
  assert.equal(exports[0][0][1][0].Actor, 'Admin');
  assert.equal(exports[0][1][1][0].Status, 'Available');
});
