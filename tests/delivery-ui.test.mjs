import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sortUsersByName } from '../js/user-sort.js';
import { cardIcon, cardButton } from '../js/mobile-card.js';
import { deliveryStatistics, assignedDeliveryWorkload, deliveryOrderState } from '../js/delivery-stats.js';

test('deliveries distinguish empty, filtered, error and recovered records', async () => {
  const elements = new Map(), events = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: false, innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, click() { this.listeners.click?.(); }, reset() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  let result = [], orderResult = [];
  const context = {
    document: { getElementById: element, addEventListener(type, fn) { events.set(type, fn); }, querySelector() { return null; } },
    listDeliveries: async () => { if (result instanceof Error) throw result; return result; },
    listOrders: async () => orderResult, listMasterRecords: async () => [], deliveryStatistics, assignedDeliveryWorkload, deliveryOrderState,
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
  orderResult = [{ id: 'o1', status: 'confirmed', orderNumber: 'SS-1', customerId: 'c1', customerSnapshot: { fullName: 'Ravi Bhai' }, assignedUserId: 'u1', lines: [{ kind: 'item', quantityQty: 20000, orderUnitName: 'KG' }] }];
  result = [{ id: 'd1', orderId: 'o1', deliveryNumber: 'DEL-1', orderNumber: 'SS-1', customerId: 'c1', customerSnapshot: { fullName: 'Ravi Bhai' }, assignedUserId: 'u1', assignedUserName: 'Anand', deliveredByName: 'Anand', deliveredAt: { seconds: 1, toDate: () => new Date('2026-11-01T10:00:00Z') }, complete: false, lines: [{ deliveredQty: 12000, unit: 'KG' }] }];
  element('delivery-retry').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(element('delivery-error').hidden, true);
  assert.equal(element('delivery-table').hidden, false);
  assert.match(element('delivery-mobile-list').innerHTML, /DEL-1/);
  assert.match(element('delivery-mobile-list').innerHTML, /Partial/);
  assert.match(element('delivery-mobile-list').innerHTML, /12 KG/);
  assert.match(element('delivery-stats').innerHTML, /KG Delivered[\s\S]*12 <small>KG<\/small>[\s\S]*60\.00%/);
  assert.match(element('delivery-stats').innerHTML, /KG Pending[\s\S]*8 <small>KG<\/small>[\s\S]*40\.00%/);
  assert.match(element('delivery-users').innerHTML, /<table class="delivery-users-table">[\s\S]*Assigned User[\s\S]*Pending Orders[\s\S]*Pending KG[\s\S]*Delivered Orders[\s\S]*Delivered KG[\s\S]*Completion[\s\S]*Action/);
  assert.match(element('delivery-users').innerHTML, /8 KG[\s\S]*60%[\s\S]*role="progressbar"[\s\S]*View Pending/);
  orderResult.push({ id: 'o2', status: 'confirmed', orderNumber: 'SS-2', customerId: 'c2', customerSnapshot: { fullName: 'Another' }, assignedUserId: 'u2', assignedUserName: 'Zara', lines: [{ kind: 'item', quantityQty: 3000, orderUnitName: 'KG' }] });
  element('delivery-refresh').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const table = element('delivery-users').innerHTML;
  assert.ok(table.indexOf('Anand') < table.indexOf('Zara'), 'equal pending order counts sort by pending KG');
  element('delivery-status').value = 'partial'; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.match(element('delivery-body').innerHTML, /SS-1[\s\S]*Partially Delivered/);
  assert.doesNotMatch(element('delivery-body').innerHTML, /SS-2/);
  element('delivery-status').value = 'delivered'; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.equal(element('delivery-table').hidden, true);
  element('delivery-status').value = '';
  element('delivery-users').listeners.click({ target: { closest: () => ({ dataset: { pendingUser: 'u1' } }) } });
  assert.equal(element('delivery-user').value, 'u1');
  assert.equal(element('delivery-status').value, 'pending');
  assert.equal(element('delivery-pending-nav').hidden, false);
  assert.match(element('delivery-pending-context').textContent, /Anand/);
  assert.match(element('delivery-pending-orders').innerHTML, /SS-1[\s\S]*Ravi Bhai[\s\S]*8 KG[\s\S]*Partial/);
  element('delivery-back-all-pending').click();
  assert.equal(element('delivery-user').value, '');
  assert.equal(element('delivery-status').value, 'pending');
  assert.equal(element('delivery-pending-nav').hidden, true);
  assert.match(element('delivery-body').innerHTML, /SS-1[\s\S]*Partially Delivered/);
  assert.match(element('delivery-body').innerHTML, /SS-2[\s\S]*Pending/);
  element('delivery-user').value = 'u1';
  element('delivery-search').value = 'SS-1';
  element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.equal(element('delivery-pending-nav').hidden, false);
  element('delivery-back-all-pending').click();
  assert.equal(element('delivery-search').value, 'SS-1');
  assert.doesNotMatch(element('delivery-body').innerHTML, /SS-2/);
  element('delivery-search').value = '';
  element('delivery-user').value = 'u1';
  element('delivery-filters').listeners.submit({ preventDefault() {} });
  element('delivery-body').listeners.click({ target: { closest: (selector) => selector === '[data-rollback-id]' ? { dataset: { rollbackId: 'd1' } } : null } });
  assert.equal(element('delivery-rollback-dialog').open, true);
  assert.match(element('delivery-rollback-details').innerHTML, /SS-1[\s\S]*Ravi Bhai[\s\S]*Anand[\s\S]*12/);
  element('delivery-rollback-cancel').click();
  result[0].status = 'rolled_back'; result[0].rolledBackAt = result[0].deliveredAt; result[0].rolledBackByName = 'Admin'; result[0].rollbackReason = 'Duplicate entry';
  element('delivery-refresh').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(element('delivery-stats').innerHTML, /KG Pending[\s\S]*20 <small>KG/);
  element('delivery-status').value = 'rolled_back'; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.match(element('delivery-body').innerHTML, /Rolled Back[\s\S]*Admin[\s\S]*Duplicate entry/);
  assert.doesNotMatch(element('delivery-body').innerHTML, /data-rollback-id/);
  element('delivery-from').value = '2026-11-02'; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.equal(element('delivery-table').hidden, true);
  element('delivery-from').value = ''; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.match(element('delivery-body').innerHTML, /Duplicate entry/);
  element('delivery-status').value = ''; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.match(element('delivery-body').innerHTML, /Rolled Back/);
  element('delivery-status').value = 'pending'; element('delivery-filters').listeners.submit({ preventDefault() {} });
  assert.match(element('delivery-body').innerHTML, /SS-1[\s\S]*Pending/);
  assert.doesNotMatch(element('delivery-body').innerHTML, /Duplicate entry/);
});
