import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryStatistics, assignedDeliveryWorkload, deliveryOrderState } from '../js/delivery-stats.js';

const item = (quantityQty, unit = 'KG') => ({ kind: 'item', quantityQty, orderUnitName: unit, itemSnapshot: { unitSymbol: 'KG' } });
const order = (id, lines, status = 'confirmed') => ({ id, status, lines });
const delivery = (orderId, quantities) => ({ orderId, lines: quantities.map((deliveredQty) => ({ deliveredQty })) });

test('zero orders and all pending orders have safe percentages', () => {
  assert.deepEqual(deliveryStatistics([], []), { deliveredOrders: 0, pendingOrders: 0, deliveredKg: 0, pendingKg: 0, deliveredOrderPercent: 0, pendingOrderPercent: 0, deliveredKgPercent: 0, pendingKgPercent: 0 });
  const result = deliveryStatistics([order('a', [item(2000)])], []);
  assert.equal(result.pendingOrders, 1);
  assert.equal(result.pendingKg, 2);
  assert.equal(result.pendingKgPercent, 100);
});

test('split and partial deliveries count each order once', () => {
  const result = deliveryStatistics([order('a', [item(2000), item(1000)])], [delivery('a', [500, 0]), delivery('a', [1000, 1000])]);
  assert.equal(result.deliveredOrders, 0);
  assert.equal(result.pendingOrders, 1);
  assert.equal(result.deliveredKg, 2.5);
  assert.equal(result.pendingKg, 0.5);
  assert.equal(result.deliveredKgPercent.toFixed(2), '83.33');
  const complete = deliveryStatistics([order('a', [item(2000), item(1000)])], [delivery('a', [500, 0]), delivery('a', [1500, 1000])]);
  assert.equal(complete.deliveredOrders, 1);
  assert.equal(complete.pendingKg, 0);
});

test('cancelled orders are excluded and pack sizes, combos and pieces convert correctly', () => {
  const combo = { kind: 'special', quantityQty: 1000, specialSnapshot: { components: [{ quantityQty: 500, itemSnapshot: { unitSymbol: 'KG' } }, { quantityQty: 250, itemSnapshot: { unitSymbol: 'KG' } }] } };
  const orders = [order('a', [item(2000, '500 GM'), item(1000, '250 GM'), item(1000, 'PCS'), combo]), order('cancel', [item(9000)], 'cancelled')];
  const result = deliveryStatistics(orders, [delivery('a', [1000, 0, 1000, 1000]), delivery('cancel', [9000])]);
  assert.equal(result.deliveredKg, 1.25);
  assert.equal(result.pendingKg, 0.75);
  assert.equal(result.pendingOrders, 1);
});

test('updated delivery quantities change totals without double counting', () => {
  const orders = [order('a', [item(1000)])];
  assert.equal(deliveryStatistics(orders, [delivery('a', [250])]).pendingKg, 0.75);
  assert.equal(deliveryStatistics(orders, [delivery('a', [750])]).pendingKg, 0.25);
  assert.equal(deliveryStatistics(orders, [delivery('a', [1000]), delivery('a', [1000])]).deliveredKg, 1);
});

test('assigned workload uses current assignee, aggregates partial records and excludes cancelled orders', () => {
  const orders = [
    { ...order('a', [item(2000)]), assignedUserId: 'u1', assignedUserName: 'Mukesh' },
    { ...order('b', [item(1000)]), assignedUserId: 'u1', assignedUserName: 'Mukesh', ownerUid: 'another' },
    { ...order('c', [item(1000)], 'cancelled'), assignedUserId: 'u1' },
    { ...order('d', [item(1000)]), assignedUserId: 'u2', assignedUserName: 'Hiren' },
  ];
  const result = assignedDeliveryWorkload(orders, [delivery('a', [500]), delivery('a', [500]), delivery('b', [1000]), delivery('d', [1000])]);
  assert.equal(result.length, 1);
  assert.equal(result[0].userId, 'u1');
  assert.equal(result[0].pendingOrders, 1);
  assert.equal(result[0].pendingKg, 1);
  assert.equal(result[0].deliveredOrders, 1);
  assert.equal(result[0].deliveredKg, 2);
  assert.equal(result[0].progress.toFixed(2), '66.67');
});

test('rolled-back delivery quantities restore pending workload without deleting history', () => {
  const assigned = { ...order('a', [item(2000)]), assignedUserId: 'u1', assignedUserName: 'Mukesh' };
  const first = delivery('a', [1000]);
  const second = delivery('a', [1000]);
  assert.equal(deliveryOrderState(assigned, [first, second]), 'delivered');
  second.status = 'rolled_back';
  const stats = deliveryStatistics([assigned], [first, second]);
  assert.equal(stats.deliveredKg, 1);
  assert.equal(stats.pendingKg, 1);
  assert.equal(stats.pendingOrders, 1);
  assert.equal(deliveryOrderState(assigned, [first, second]), 'partial');
  assert.equal(assignedDeliveryWorkload([assigned], [first, second])[0].pendingKg, 1);
  first.rolledBackAt = { seconds: 1 };
  assert.equal(deliveryOrderState(assigned, [first, second]), 'pending');
  assert.equal(deliveryStatistics([assigned], [first, second]).pendingKg, 2);
});
