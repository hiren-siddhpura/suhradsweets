import test from 'node:test';
import assert from 'node:assert/strict';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';
import { itemStockQuantity, requiredStock, validateDistinctOrderLines, validateOrderInput } from '../functions/order-operations.js';

test('order choices are fixed and item prices are independent', () => {
  assert.deepEqual(availableOrderUnits('admin').map((unit) => unit.id), ['kg', '500gm', '250gm']);
  assert.deepEqual(availableOrderUnits('account_admin').map((unit) => unit.id), ['kg', '500gm']);
  assert.deepEqual(availableOrderUnits('user').map((unit) => unit.id), ['kg', '500gm']);
  const item = { defaultSellingPrice: 100, sellingPrice500Gm: 60, sellingPrice250Gm: 35 };
  assert.equal(itemUnitPrice(item, 'kg'), 100);
  assert.equal(itemUnitPrice(item, '500gm'), 60);
  assert.equal(itemUnitPrice(item, '250gm'), 35);
  assert.equal(itemUnitPrice({ defaultSellingPrice: 100 }, '500gm'), undefined);
  assert.equal(itemUnitPrice(item, 'historical-unit-id'), 100);
});

test('historical lines keep their original unit label', () => {
  assert.equal(orderLineUnitLabel({ orderUnitName: '500 GM', itemSnapshot: { unitSymbol: 'kg' } }), '500 GM');
  assert.equal(orderLineUnitLabel({ itemSnapshot: { unitSymbol: 'kg' } }), 'kg');
});

test('the same product may use different units but not the same resolved unit twice', () => {
  const kg = { kind: 'item', productId: 'itemA', orderUnitName: 'KG' };
  const half = { kind: 'item', productId: 'itemA', orderUnitName: '500 GM' };
  assert.doesNotThrow(() => validateDistinctOrderLines([kg, half]));
  assert.throws(() => validateDistinctOrderLines([half, { ...half }]), /same unit/);
  assert.throws(() => validateDistinctOrderLines([kg, { ...kg, orderUnitName: undefined }]), /same unit/);
  const combo = { kind: 'special', productId: 'comboA' };
  assert.throws(() => validateDistinctOrderLines([combo, combo]), /same unit/);
});

test('order quantities convert to KG stock milli-units', () => {
  assert.equal(itemStockQuantity({ quantityQty: 1000, orderUnitName: 'KG' }), 1000);
  assert.equal(itemStockQuantity({ quantityQty: 1000, orderUnitName: '500 GM' }), 500);
  assert.equal(itemStockQuantity({ quantityQty: 1000, orderUnitName: '250 GM' }), 250);
  assert.equal(itemStockQuantity({ quantityQty: 3000, orderUnitName: '500 GM' }), 1500);
  assert.equal(itemStockQuantity({ quantityQty: 1000 }), 1000);
  assert.equal(requiredStock([
    { kind: 'item', productId: 'sweet', quantityQty: 1000, orderUnitName: 'KG' },
    { kind: 'item', productId: 'sweet', quantityQty: 1000, orderUnitName: '500 GM' },
    { kind: 'item', productId: 'sweet', quantityQty: 1000, orderUnitName: '250 GM' },
  ]).get('sweet'), 1750);
  assert.throws(() => itemStockQuantity({ quantityQty: 1, orderUnitName: '500 GM' }), /too precise/);
});

test('order lines require whole quantities in their selected unit', () => {
  const input = { orderDate: '2026-10-17', deliveryDate: null, notes: '', lines: [{ kind: 'item', productId: 'sweet', quantityQty: 1000, unitId: '500gm' }] };
  assert.doesNotThrow(() => validateOrderInput(input));
  assert.throws(() => validateOrderInput({ ...input, lines: [{ ...input.lines[0], quantityQty: 999 }] }), /whole numbers/);
  assert.throws(() => validateOrderInput({ ...input, lines: [{ ...input.lines[0], quantityQty: 0 }] }), /valid product and quantity/);
});
