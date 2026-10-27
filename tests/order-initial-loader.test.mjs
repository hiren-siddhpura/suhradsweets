import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hasPermission, isStaff, validateProfile } from '../js/permissions.js';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';

const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const nodes = new Map(), listeners = {}, pending = [], active = new Set();
  let page = 'dashboard', reads = 0, starts = 0;
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentHTML() {}, querySelectorAll() { return []; }, showModal() {}, close() {} });
    return nodes.get(id);
  };
  const context = {
    document: { getElementById: el, addEventListener(type, fn) { listeners[type] = fn; }, querySelector(selector) { return selector === '[data-page].is-active' ? { dataset: { page } } : null; } },
    console: { error() {} }, hasPermission, isStaff, validateProfile, availableOrderUnits, itemUnitPrice, orderLineUnitLabel,
    omsLoading: { start() { const token = ++starts; active.add(token); return token; }, stop(token) { active.delete(token); } },
    listOrders() { reads++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    listCustomers: async () => [], listOrderProducts: async () => [], listInvoices: async () => [], getOrderTaking: async () => true,
    listMasterRecords: async () => [], listActivity: async () => ({ rows: [], hasMore: false }), callOperation: async () => ({ items: [] }), showToast() {},
  };
  vm.runInNewContext(`${source}\nthis.init = initOrderUi;`, context);
  const orders = context.init({ db: {}, functions: {}, auth: {}, mode: 'emulator' });
  orders.setSession({ uid: 'admin' }, { role: 'admin', active: true, displayName: 'Admin' });
  const navigate = (next) => { page = next; listeners['oms:pagechange']({ detail: { page: next } }); };
  return { el, pending, active, navigate, get reads() { return reads; }, get starts() { return starts; } };
}

test('slow first Orders load keeps one standard loader and request across navigation', async () => {
  const app = setup();
  app.navigate('orders');
  assert.equal(app.active.size, 1);
  assert.equal(app.el('order-loading').hidden, false);
  assert.equal(app.el('order-message').textContent, '');
  assert.equal(app.reads, 1);
  app.navigate('dashboard');
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, true);
  app.navigate('orders');
  assert.equal(app.active.size, 1);
  assert.equal(app.reads, 1);
  app.pending[0].resolve([]);
  await tick(); await tick();
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, true);
  assert.match(app.el('order-body').innerHTML, /No orders match/);
  app.navigate('dashboard'); app.navigate('orders');
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, false);
  assert.equal(app.starts, 3); // Two order fetches and the activity log fetch.
  app.pending[1].resolve([]);
  await tick();
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, true);
  const refresh = app.el('order-refresh').listeners.click();
  assert.equal(app.active.size, 0);
  app.pending[2].resolve([]);
  await refresh;
});

test('failed initial Orders load releases loader, clears records and allows retry', async () => {
  const app = setup();
  app.navigate('orders');
  app.pending[0].reject(new Error('network unavailable'));
  await tick();
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, true);
  assert.match(app.el('order-message').textContent, /network unavailable/);
  assert.equal(app.el('order-body').innerHTML, '');
  app.navigate('dashboard'); app.navigate('orders');
  assert.equal(app.active.size, 1);
  app.pending[1].resolve([]);
  await tick(); await tick();
  assert.equal(app.active.size, 0);
  assert.equal(app.el('order-loading').hidden, true);
  assert.match(app.el('order-body').innerHTML, /No orders match/);
});
