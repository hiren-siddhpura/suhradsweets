import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8');
const warningSource = source.slice(source.indexOf('  function stockWarning('), source.indexOf('  function itemOptions('));
const item = (quantityQty, unitId = 'kg', productId = 'cake') => ({ kind: 'item', productId, unitId, quantityQty });
const combo = (quantityQty) => ({ kind: 'special', productId: 'combo', quantityQty });

function check(lines, available, existing = null) {
  const context = {
    targetId: existing?.id || '', orders: existing ? [existing] : [],
    specials: [{ id: 'combo', components: [{ itemId: 'cake', quantityQty: 500 }, { itemId: 'roll', quantityQty: 500 }] }],
    stockAvailability: new Map(Object.entries(available).map(([id, availableQty]) => [id, { availableQty, status: 'available' }])),
    admin: () => true,
  };
  vm.runInNewContext(`${warningSource}\nthis.check = stockWarning;`, context);
  return context.check(lines);
}

test('new orders use only available stock', () => {
  assert.equal(check([item(1000)], { cake: 1250 }), '');
  assert.match(check([item(2000)], { cake: 1250 }), /exceeds available stock/);
});

test('editing a confirmed order checks the delta, including unchanged and excessive edits', () => {
  const existing = { id: 'orderA', status: 'confirmed', stockDeductions: [{ itemId: 'cake', quantityQty: 2000 }] };
  assert.equal(check([item(2000)], { cake: 0 }, existing), '');
  assert.equal(check([item(3000)], { cake: 1000 }, existing), '');
  assert.match(check([item(4000)], { cake: 1000 }, existing), /exceeds available stock/);
  assert.match(check([item(1000)], { cake: 0 }), /exceeds available stock/);
});

test('combo components and pack sizes share each item stock balance', () => {
  const existing = { id: 'orderA', status: 'invoiced', stockDeductions: [{ itemId: 'cake', quantityQty: 1000 }, { itemId: 'roll', quantityQty: 500 }] };
  assert.equal(check([combo(1000), item(1000, '500gm')], { cake: 0, roll: 0 }, existing), '');
  assert.match(check([combo(2000), item(1000, '500gm')], { cake: 1000, roll: 250 }, existing), /exceeds available stock/);
  assert.equal(check([item(1000, '250gm'), item(1000, '500gm')], { cake: 750 }), '');
  assert.match(check([item(1000, 'pcs')], { cake: 750 }), /exceeds available stock/);
});

test('a draft has no confirmed stock to credit back', () => {
  const existing = { id: 'draftA', status: 'draft', stockDeductions: [{ itemId: 'cake', quantityQty: 2000 }] };
  assert.match(check([item(2000)], { cake: 1000 }, existing), /exceeds available stock/);
});

test('repeated failed quantity input shows one stock toast', () => {
  const quantitySource = source.slice(source.indexOf('  function setUnitQuantity('), source.indexOf('  function renderAddedItems('));
  const toasts = [];
  const context = {
    draftLines: () => [],
    stockWarning: () => 'Requested quantity exceeds available stock.',
    showToast: (message) => toasts.push(message),
  };
  vm.runInNewContext(`${quantitySource}\nthis.setQuantity = setUnitQuantity;`, context);
  const input = { dataset: { kind: 'item', productId: 'cake', unitId: 'kg' } };
  assert.equal(context.setQuantity(input, 2), false);
  assert.equal(context.setQuantity(input, 2), false);
  assert.equal(toasts.length, 1);
});
