import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkEligibility, remainingDeliveryLines, retainFilteredSelection } from '../js/order-bulk.js';

const order = (id, status = 'confirmed', quantityQty = 3000) => ({ id, status, orderNumber: id, lines: [{ kind: 'item', productId: 'sweet', quantityQty }] });

test('selection spans the full filtered result and drops records outside changed filters', () => {
  const all = [order('one'), order('two'), order('three')];
  const filtered = all.filter((row) => row.id !== 'three');
  const selected = new Set(filtered.map((row) => row.id));
  assert.deepEqual([...selected], ['one', 'two']);
  assert.deepEqual([...retainFilteredSelection(selected, [all[1]])], ['two']);
  assert.deepEqual([...retainFilteredSelection(selected, [])], []);
});

test('bulk delivery uses remaining quantities and rejects completed or invalid orders', () => {
  const first = order('one');
  const history = [{ orderId: 'one', lines: [{ deliveredQty: 1000 }] }];
  assert.equal(remainingDeliveryLines(first, history)[0].remainingQty, 2000);
  assert.deepEqual(bulkEligibility(first, 'delivered', history).lines, [{ deliveredQty: 2000 }]);
  assert.match(bulkEligibility(first, 'delivered', [{ orderId: 'one', lines: [{ deliveredQty: 3000 }] }]).reason, /fully delivered/);
  assert.match(bulkEligibility({ ...first, archivedAt: true }, 'delivered', history).reason, /Archived/);
  assert.match(bulkEligibility(order('two', 'cancelled'), 'delivered', []).reason, /current status/);
  assert.equal(bulkEligibility(order('three', 'draft'), 'confirmed', []).operation, 'confirmOrder');
  assert.match(bulkEligibility({ ...order('special', 'draft'), lines: [{ kind: 'special', quantityQty: 1000 }] }, 'confirmed', [], { role: 'user' }).reason, /Only Admin/);
  assert.match(bulkEligibility({ ...first, invoiceId: 'invoice-one' }, 'delivered', history).reason, /invoice exists/);
  assert.match(bulkEligibility(first, 'invoiced', history, { role: 'user' }).reason, /Admin/);
});

test('bulk invoicing accepts complete active orders and reports invalid or duplicate invoices', () => {
  const valid = { ...order('one'), customerId: 'customer-one', customerSnapshot: { fullName: 'Asha' }, orderDate: '2026-11-01', subtotal: 20000, grandTotal: 20000, stockDeductions: [{ itemId: 'sweet', quantityQty: 2000 }], lines: [{ kind: 'item', quantityQty: 2000, unitPricePaise: 10000, lineTotalPaise: 20000, itemSnapshot: { name: 'Sweet' } }] };
  assert.equal(bulkEligibility(valid, 'invoiced', [], { role: 'admin' }).operation, 'createInvoiceFromOrder');
  assert.equal(bulkEligibility({ ...valid, status: 'delivered' }, 'invoiced', [], { role: 'account_admin' }).invoiceNumber, 'INV-one');
  assert.match(bulkEligibility({ ...valid, invoiceId: 'one' }, 'invoiced', [], { role: 'admin' }).reason, /already exists/);
  assert.match(bulkEligibility({ ...valid, status: 'cancelled' }, 'invoiced', [], { role: 'admin' }).reason, /Confirmed or Delivered/);
  assert.match(bulkEligibility({ ...valid, grandTotal: null }, 'invoiced', [], { role: 'admin' }).reason, /totals/);
});
