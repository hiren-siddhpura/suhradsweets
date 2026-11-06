import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentStatusStats } from '../js/payment-status-stats.js';

const invoice = (id, totalPaise, verifiedPaidPaise = 0) => ({ id, customerId: id, customerSnapshot: { fullName: id }, ownerUid: 'u1', totalPaise, verifiedPaidPaise, paymentStatus: verifiedPaidPaise ? 'partial' : 'unpaid' });
const single = (id, status, amount, mode = 'cash') => ({ type: 'single', status, amount, row: { id, invoiceId: id, mode } });

test('all pending payments and outstanding invoices', () => {
  const result = paymentStatusStats([single('a', 'pending', 4000)], [invoice('a', 10000)]);
  assert.equal(result.totalPayments, 4000);
  assert.equal(result.pendingPaymentsPercent, 100);
  assert.equal(result.approvedPayments, 0);
  assert.equal(result.pendingCollection, 10000);
  assert.equal(result.pendingCollectionPercent, 100);
});

test('all approved cash and online payments', () => {
  const rows = [single('a', 'verified', 6000), single('b', 'verified', 4000, 'upi')];
  const result = paymentStatusStats(rows, [invoice('a', 6000, 6000), invoice('b', 4000, 4000)]);
  assert.equal(result.approvedPaymentsPercent, 100);
  assert.equal(result.cashCollection, 6000);
  assert.equal(result.onlineCollection, 4000);
  assert.equal(result.cashCollectionPercent, 60);
  assert.equal(result.onlineCollectionPercent, 40);
});

test('mixed payment states, partial payment, rejected and reversed amounts', () => {
  const rows = [single('a', 'verified', 2500), single('b', 'pending', 1500), single('c', 'rejected', 1000), single('d', 'reversed', 500)];
  const result = paymentStatusStats(rows, [invoice('a', 10000, 2500)]);
  assert.equal(result.totalPayments, 5500);
  assert.equal(result.pendingPaymentsPercent, 1500 / 5500 * 100);
  assert.equal(result.approvedPaymentsPercent, 2500 / 5500 * 100);
  assert.equal(result.pendingCollection, 7500);
  assert.equal(result.totalCollection, 10000);
  assert.equal(result.cashCollectionPercent, 25);
});

test('cash only, online only, and zero totals', () => {
  assert.equal(paymentStatusStats([single('a', 'verified', 5000)], []).cashCollectionPercent, 100);
  assert.equal(paymentStatusStats([single('a', 'verified', 5000, 'bank_transfer')], []).onlineCollectionPercent, 100);
  const zero = paymentStatusStats([], []);
  assert.equal(zero.totalCollection, 0);
  assert.equal(zero.pendingCollectionPercent, 0);
  assert.equal(zero.totalPaymentsPercent, 0);
});

test('mixed bulk collection counts once and applies mode filter to entries', () => {
  const bulk = { type: 'bulk', status: 'verified', amount: 10000, row: { approvedPaise: 10000, entries: [{ mode: 'cash', amountPaise: 4000 }, { mode: 'upi', amountPaise: 6000 }], allocations: [{ invoiceId: 'a', paymentIndex: 0 }, { invoiceId: 'b', paymentIndex: 1 }] } };
  const result = paymentStatusStats([bulk], [invoice('a', 7000, 4000), invoice('b', 6000, 6000)]);
  assert.equal(result.approvedPayments, 10000);
  assert.equal(result.cashCollection, 4000);
  assert.equal(result.onlineCollection, 6000);
  assert.equal(result.pendingCollection, 3000);
  const filtered = paymentStatusStats([bulk], [invoice('a', 7000, 4000), invoice('b', 6000, 6000)], { mode: 'cash' });
  assert.equal(filtered.totalPayments, 4000);
  assert.equal(filtered.cashCollection, 4000);
  assert.equal(filtered.onlineCollection, 0);
  assert.equal(filtered.pendingCollection, 3000);
});

test('user, customer, date, and status filters scope invoice balances', () => {
  const invoices = [invoice('a', 10000), { ...invoice('b', 8000), ownerUid: 'u2' }];
  assert.equal(paymentStatusStats([], invoices, { user: 'u1' }).pendingCollection, 10000);
  assert.equal(paymentStatusStats([], invoices, { customer: 'b' }).pendingCollection, 8000);
  assert.equal(paymentStatusStats([], invoices, { status: 'verified' }).pendingCollection, 0);
  assert.equal(paymentStatusStats([], invoices, { from: '2026-01-01' }).pendingCollection, 0);
});

test('cancelled invoices retain payment history but contribute nothing to active totals', () => {
  const rows = [single('a', 'verified', 5000), single('b', 'pending', 2000)];
  const result = paymentStatusStats(rows, [{ ...invoice('a', 5000, 5000), status: 'cancelled' }, { ...invoice('b', 9000), status: 'cancelled' }]);
  assert.equal(result.totalPayments, 0);
  assert.equal(result.pendingPayments, 0);
  assert.equal(result.approvedPayments, 0);
  assert.equal(result.pendingCollection, 0);
  assert.equal(result.cashCollection, 0);
});

test('mixed bulk collection excludes only cancelled invoice allocation', () => {
  const bulk = { type: 'bulk', status: 'verified', amount: 9000, row: { approvedPaise: 9000, entries: [{ mode: 'cash', amountPaise: 9000 }], allocations: [{ invoiceId: 'a', paymentIndex: 0, amountPaise: 4000 }, { invoiceId: 'b', paymentIndex: 0, amountPaise: 5000 }] } };
  const result = paymentStatusStats([bulk], [{ ...invoice('a', 4000, 4000), status: 'cancelled' }, invoice('b', 5000, 5000)]);
  assert.equal(result.totalPayments, 5000);
  assert.equal(result.approvedPayments, 5000);
  assert.equal(result.cashCollection, 5000);
});
