import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sortUsersByName } from '../js/user-sort.js';
import { cardIcon, cardButton } from '../js/mobile-card.js';

test('deliveries distinguish empty, filtered, error and recovered records', async () => {
  const elements = new Map(), events = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: false, innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, click() { this.listeners.click?.(); } });
    return elements.get(id);
  };
  let result = [];
  const context = {
    document: { getElementById: element, addEventListener(type, fn) { events.set(type, fn); }, querySelector() { return null; } },
    listDeliveries: async () => { if (result instanceof Error) throw result; return result; },
    isStaff: () => true, sortUsersByName, cardIcon, cardButton, showToast() {}, uniqueId: () => 'id',
    omsLoading: { start: () => 'load', stop() {} },
  };
  const source = readFileSync(new URL('../js/delivery-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initDeliveryUi', 'function initDeliveryUi');
  vm.runInNewContext(`${source}\nthis.init = initDeliveryUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin' });
  const load = async () => { events.get('oms:pagechange')({ detail: { page: 'deliveries' } }); await new Promise((resolve) => setTimeout(resolve, 0)); };

  await load();
  assert.equal(element('delivery-empty').hidden, false);
  assert.equal(element('delivery-error').hidden, true);
  assert.equal(element('delivery-table').hidden, true);
  assert.match(element('delivery-empty-description').textContent, /once orders are delivered/);

  element('delivery-search').value = 'missing';
  element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.equal(element('delivery-empty-clear').hidden, false);
  assert.match(element('delivery-empty-description').textContent, /current filters/);

  result = new Error('Network unavailable');
  await load();
  assert.equal(element('delivery-error').hidden, false);
  assert.equal(element('delivery-empty').hidden, true);
  assert.match(element('delivery-error-message').textContent, /Network unavailable/);

  element('delivery-search').value = '';
  element('delivery-clear').click();
  result = [{ id: 'd1', deliveryNumber: 'DEL-1', orderNumber: 'SS-1', customerId: 'c1', customerSnapshot: { fullName: 'Ravi Bhai' }, assignedUserId: 'u1', assignedUserName: 'Anand', deliveredByName: 'Anand', deliveredAt: { seconds: 1, toDate: () => new Date('2026-11-01T10:00:00Z') }, complete: false, lines: [{ deliveredQty: 12000, unit: 'KG' }] }];
  element('delivery-retry').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(element('delivery-error').hidden, true);
  assert.equal(element('delivery-table').hidden, false);
  assert.match(element('delivery-mobile-list').innerHTML, /DEL-1/);
  assert.match(element('delivery-mobile-list').innerHTML, /Partial/);
  assert.match(element('delivery-mobile-list').innerHTML, /12 KG/);
});
