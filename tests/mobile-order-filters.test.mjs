import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyMobileFilterSource } from '../js/mobile-toolbar.js';
import { hasPermission, isStaff, validateProfile } from '../js/permissions.js';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';

const bulkSource = readFileSync(new URL('../js/order-bulk.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const uiSource = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');

test('mobile Apply submits Orders user, status, and date filters from the sheet', async () => {
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentHTML() {}, querySelectorAll() { return []; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const records = [
    { id: 'one', orderNumber: 'SO-1', status: 'confirmed', orderDate: '2026-10-01', ownerUid: 'a', assignedUserId: 'a', customerSnapshot: { fullName: 'Asha' }, grandTotal: 1000 },
    { id: 'two', orderNumber: 'SO-2', status: 'delivered', orderDate: '2026-10-15', ownerUid: 'b', assignedUserId: 'b', customerSnapshot: { fullName: 'Bela' }, grandTotal: 1000 },
    { id: 'three', orderNumber: 'SO-3', status: 'confirmed', orderDate: '2026-11-01', ownerUid: 'b', assignedUserId: 'b', customerSnapshot: { fullName: 'Charu' }, grandTotal: 1000, lines: [{ kind: 'item', quantityQty: 1000 }] },
  ];
  const context = { document: { getElementById: el, addEventListener() {}, querySelector() { return null; } }, hasPermission, isStaff, validateProfile, availableOrderUnits, itemUnitPrice, orderLineUnitLabel, showToast() {}, listOrders: async () => records, listCustomers: async () => [], listOrderProducts: async () => [], listInvoices: async () => [], listDeliveries: async () => [], getOrderTaking: async () => true, listMasterRecords: async () => [{ id: 'a', role: 'user', active: true, displayName: 'A' }, { id: 'b', role: 'user', active: true, displayName: 'B' }], listActivity: async () => ({ rows: [], hasMore: false }), callOperation: async () => ({ items: [] }) };
  vm.runInNewContext(`${bulkSource}\n${uiSource}\nthis.init = initOrderUi;`, context);
  const ui = context.init({ db: {}, functions: {}, auth: {}, mode: 'emulator' });
  ui.setSession({ uid: 'admin' }, { role: 'admin', active: true, displayName: 'Admin' });
  await el('order-refresh').listeners.click();
  assert.match(el('order-mobile-list').innerHTML, /order-card-header.*SO-1/s);
  assert.match(el('order-mobile-list').innerHTML, /order-card-customer">Asha/);
  assert.match(el('order-mobile-list').innerHTML, /2026-10-01/);
  assert.match(el('order-mobile-list').innerHTML, /Order Total/);
  assert.match(el('order-mobile-list').innerHTML, /aria-label="View SO-1"/);
  assert.match(el('order-mobile-list').innerHTML, /aria-label="Create Invoice SO-1"|aria-label="Invoice SO-1"/);
  assert.match(el('order-mobile-list').innerHTML, /data-action="cancelOrder"/);
  el('order-select-all').listeners.change({ target: { checked: true } });
  assert.match(el('order-selection-count').textContent, /3 selected.*3 matching/);
  const form = { matches: (selector) => selector === 'form', requestSubmit: () => el('order-filters').listeners.submit({ preventDefault() {} }) };
  const apply = () => applyMobileFilterSource(form, []);
  el('order-user').value = 'b'; apply();
  assert.match(el('order-selection-count').textContent, /2 matching/);
  assert.match(el('order-selection-count').textContent, /2 selected/);
  el('order-status').value = 'confirmed'; apply();
  assert.match(el('order-selection-count').textContent, /1 matching/);
  assert.match(el('order-mobile-list').innerHTML, /Charu/);
  el('order-from').value = '2026-11-02'; apply();
  assert.match(el('order-selection-count').textContent, /0 matching/);
  el('order-from').value = '2026-10-01'; el('order-to').value = '2026-10-31'; apply();
  assert.match(el('order-selection-count').textContent, /0 matching/);
  el('order-status').value = ''; apply();
  assert.match(el('order-selection-count').textContent, /1 matching/);
  assert.match(el('order-mobile-list').innerHTML, /Bela/);
  ui.setSession({ uid: 'b' }, { role: 'user', active: true, displayName: 'B' });
  await el('order-refresh').listeners.click();
  const cards = el('order-mobile-list').innerHTML.split('<article class="order-mobile-card">');
  const otherOrder = cards.find((card) => card.includes('SO-1'));
  const ownOrder = cards.find((card) => card.includes('SO-3'));
  assert.match(otherOrder, /data-action="viewOrder"/);
  assert.doesNotMatch(otherOrder, /data-action="(editOrder|createDelivery|invoiceOrder|cancelOrder)"/);
  assert.match(ownOrder, /data-action="createDelivery"/);
  assert.doesNotMatch(ownOrder, /data-action="cancelOrder"/);
});
