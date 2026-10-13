import test from 'node:test';
import assert from 'node:assert/strict';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';

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
