import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryStatistics } from '../js/delivery-stats.js';

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
