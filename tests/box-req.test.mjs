import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBoxRequirements } from '../js/box-req-calc.js';
const line = (name, productId, unit, boxes) => ({ kind: 'item', productId, orderUnitId: unit, quantityQty: boxes * 1000, itemSnapshot: { name, unitSymbol: 'kg' } });

test('aggregates actual order line counts by item and package without counting duplicate orders', () => {
  const orders = [
    { id: 'a', status: 'confirmed', lines: [line('Kaju Katri', 'kaju', '250gm', 10), line('Kaju Katri', 'kaju', '500gm', 60), line('Badam Katri', 'badam', 'kg', 2)] },
    { id: 'b', status: 'delivered', lines: [line('Kaju Katri', 'kaju', 'kg', 5), line('Badam Katri', 'badam', '250gm', 3)] },
    { id: 'a', status: 'confirmed', lines: [line('Kaju Katri', 'kaju', '250gm', 10)] },
    { id: 'c', status: 'cancelled', lines: [line('Kaju Katri', 'kaju', '250gm', 99)] },
    { id: 'd', status: 'rejected', lines: [line('Kaju Katri', 'kaju', '250gm', 99)] },
    { id: 'e', status: 'draft', lines: [line('Kaju Katri', 'kaju', '250gm', 99)] },
  ];
  const result = calculateBoxRequirements(orders);
  assert.equal(result.orderCount, 2);
  assert.deepEqual(result.totals, { '250gm': 13, '500gm': 60, kg: 7 });
  assert.deepEqual(result.items.find((item) => item.id === 'kaju').quantities, { '250gm': 10, '500gm': 60, kg: 5 });
});

test('supports historical unit names and rejects ambiguous quantities', () => {
  const result = calculateBoxRequirements([{ id: 'old', status: 'ready', lines: [{ kind: 'item', productId: 'a', quantityQty: 2000, orderUnitName: '500 GM', itemSnapshot: { name: 'Anjir Roll' } }] }]);
  assert.equal(result.totals['500gm'], 2);
  assert.throws(() => calculateBoxRequirements([{ id: 'bad', status: 'confirmed', lines: [line('A', 'a', 'kg', 1.5)] }]), /unsupported/);
  assert.deepEqual(calculateBoxRequirements([]).items, []);
});

test('separates combinations and gift wrapping without duplicating orders', () => {
  const orders = [{ id: 'gift', status: 'confirmed', lines: [
    line('Gift Packing', 'packing', 'pcs', 1),
    line('Kaju Katri', 'kaju', '500gm', 10),
    { kind: 'special', productId: 'combo', quantityQty: 8000, specialSnapshot: { name: 'Kaju Katri + Anjir Roll' } },
  ] }, { id: 'gift', status: 'confirmed', lines: [line('Kaju Katri', 'kaju', '500gm', 10)] },
  { id: 'plain', status: 'ready', lines: [line('Anjir Roll', 'anjir', 'kg', 5)] }];
  const result = calculateBoxRequirements(orders);
  assert.equal(result.totals['500gm'], 10);
  assert.equal(result.items.some((item) => item.name === 'Gift Packing'), false);
  assert.deepEqual(result.specials.map(({ name, quantity, unit }) => [name, quantity, unit]), [['Kaju Katri + Anjir Roll', 8, 'PCS']]);
  assert.deepEqual(result.wrapping.map(({ name, quantity }) => [name, quantity]), [['Kaju Katri', 10], ['Kaju Katri + Anjir Roll', 8]]);
  assert.deepEqual(result.wrappingTotals, { '500 GM': 10, PCS: 8 });
});

test('gift wrapping combines matching units and keeps different units separate', () => {
  const orders = [
    { id: 'a', status: 'confirmed', lines: [line('Gift Packing', 'packing', 'pcs', 1), line('Kaju Katri', 'kaju', '250gm', 10)] },
    { id: 'b', status: 'ready', lines: [line('Gift Packing', 'packing', 'pcs', 1), line('Kaju Katri', 'kaju', '250gm', 18), line('Kaju Katri', 'kaju', '500gm', 2)] },
    { id: 'c', status: 'confirmed', lines: [line('Anjir Roll', 'anjir', 'kg', 5)] },
  ];
  const result = calculateBoxRequirements(orders);
  assert.deepEqual(result.wrapping.map(({ name, unit, quantity }) => [name, unit, quantity]), [['Kaju Katri', '250 GM', 28], ['Kaju Katri', '500 GM', 2]]);
  assert.deepEqual(result.wrappingTotals, { '250 GM': 28, '500 GM': 2 });
});
