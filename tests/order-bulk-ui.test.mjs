import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hasPermission, isStaff, validateProfile } from '../js/permissions.js';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';

const bulkSource = readFileSync(new URL('../js/order-bulk.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const uiSource = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');

test('bulk review processes eligible deliveries, reports a failure, and retries with the same request ID', async () => {
  const nodes = new Map(), calls = [], failures = new Set(['two']);
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentHTML() {}, querySelectorAll() { return []; },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const make = (id, status) => ({ id, orderNumber: `SO-${id}`, ownerUid: 'admin', assignedUserId: 'admin', orderDate: '2026-11-01', status,
    customerSnapshot: { fullName: `Customer ${id}` }, lines: [{ kind: 'item', productId: 'sweet', quantityQty: 2000, itemSnapshot: { name: 'Sweet', unitSymbol: 'kg' } }] });
  const records = [make('one', 'confirmed'), make('two', 'confirmed'), make('three', 'cancelled')];
  let nextId = 0;
  const context = { document: { getElementById: el, addEventListener() {}, querySelector() { return null; } },
    hasPermission, isStaff, validateProfile, availableOrderUnits, itemUnitPrice, orderLineUnitLabel,
    uniqueId: () => `submission-${++nextId}`, showToast() {},
    listOrders: async () => records, listCustomers: async () => [], listOrderProducts: async () => [], listInvoices: async () => [], listDeliveries: async () => [],
    getOrderTaking: async () => true, listMasterRecords: async () => [{ id: 'admin', role: 'admin', active: true, displayName: 'Admin' }],
    listActivity: async () => ({ rows: [], hasMore: false }), callOperation: async (_functions, name, payload) => {
      if (name === 'getOrderStock') return { items: [] };
      calls.push({ name, payload });
      if (payload.orderId === 'two' && failures.delete('two')) throw new Error('temporary delivery failure');
      return { deliveryNumber: `DEL-${payload.orderId}` };
    } };
  vm.runInNewContext(`${bulkSource}\n${uiSource}\nthis.init = initOrderUi;`, context);
  context.init({ db: {}, functions: {}, auth: {}, mode: 'emulator' }).setSession({ uid: 'admin' }, { role: 'admin', active: true, displayName: 'Admin' });
  await el('order-refresh').listeners.click();
  el('order-select-all').listeners.change({ target: { checked: true } });
  assert.match(el('order-selection-count').textContent, /3 selected.*3 matching/);
  assert.match(el('order-bulk-status').innerHTML, /value="invoiced"/);
  el('order-bulk-status').value = 'delivered';
  await el('order-bulk-review').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /2 eligible.*1 cannot/);
  assert.match(el('order-bulk-details').innerHTML, /Customer three.*Cannot process/);
  await el('order-bulk-submit').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /1 successful.*1 failed.*1 skipped/);
  assert.match(el('order-bulk-details').innerHTML, /temporary delivery failure/);
  assert.equal(calls.filter((call) => call.name === 'createDelivery').length, 2);
  await el('order-bulk-retry').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /2 successful.*0 failed.*1 skipped/);
  const retried = calls.filter((call) => call.payload?.orderId === 'two');
  assert.equal(retried.length, 2);
  assert.equal(retried[0].payload.submissionId, retried[1].payload.submissionId);
  assert.equal(new Set(calls.filter((call) => call.payload?.orderId === 'one').map((call) => call.payload.submissionId)).size, 1);
});

test('bulk invoice review keeps customers separate and retries only failed invoices', async () => {
  const nodes = new Map(), calls = [], failures = new Set(['two']);
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentHTML() {}, querySelectorAll() { return []; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const make = (id, status = 'confirmed') => ({ id, orderNumber: `SO-${id}`, ownerUid: 'admin', assignedUserId: 'admin', orderDate: '2026-11-01', status, customerId: `customer-${id}`, customerSnapshot: { fullName: `Customer ${id}` }, subtotal: 20000, grandTotal: 20000, stockDeductions: [{ itemId: 'sweet', quantityQty: 2000 }], lines: [{ kind: 'item', productId: 'sweet', quantityQty: 2000, unitPricePaise: 10000, lineTotalPaise: 20000, itemSnapshot: { name: 'Sweet', unitSymbol: 'kg' } }] });
  const records = [make('one'), make('two', 'delivered'), { ...make('three'), invoiceId: 'three' }, make('four', 'cancelled')];
  const context = { document: { getElementById: el, addEventListener() {}, querySelector() { return null; } }, hasPermission, isStaff, validateProfile, availableOrderUnits, itemUnitPrice, orderLineUnitLabel, uniqueId: () => 'id', showToast() {},
    listOrders: async () => records, listCustomers: async () => [], listOrderProducts: async () => [], listInvoices: async () => [], listDeliveries: async () => [], getOrderTaking: async () => true, listMasterRecords: async () => [{ id: 'admin', role: 'admin', active: true, displayName: 'Admin' }], listActivity: async () => ({ rows: [], hasMore: false }), callOperation: async (_functions, name, payload) => { if (name === 'getOrderStock') return { items: [] }; calls.push({ name, payload }); if (payload.orderId === 'two' && failures.delete('two')) throw new Error('temporary invoice failure'); return { invoiceNumber: `INV-SO-${payload.orderId}` }; } };
  vm.runInNewContext(`${bulkSource}\n${uiSource}\nthis.init = initOrderUi;`, context);
  context.init({ db: {}, functions: {}, auth: {}, mode: 'emulator' }).setSession({ uid: 'admin' }, { role: 'admin', active: true, displayName: 'Admin' });
  await el('order-refresh').listeners.click();
  el('order-select-all').listeners.change({ target: { checked: true } });
  el('order-bulk-status').value = 'invoiced';
  await el('order-bulk-review').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /2 eligible.*2 cannot/);
  assert.match(el('order-bulk-details').innerHTML, /Customer one/);
  assert.match(el('order-bulk-details').innerHTML, /Invoice total/);
  await el('order-bulk-submit').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /1 successful.*1 failed.*2 skipped/);
  assert.match(el('order-bulk-details').innerHTML, /INV-SO-one/);
  assert.equal(calls.filter((call) => call.name === 'createInvoiceFromOrder').length, 2);
  await el('order-bulk-retry').listeners.click();
  assert.match(el('order-bulk-summary').textContent, /2 successful.*0 failed.*2 skipped/);
  assert.match(el('order-bulk-details').innerHTML, /INV-SO-two/);
  assert.deepEqual(calls.filter((call) => call.name === 'createInvoiceFromOrder').map((call) => call.payload.orderId).sort(), ['one', 'two', 'two']);
});
