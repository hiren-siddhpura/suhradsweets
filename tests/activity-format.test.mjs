import test from 'node:test';
import assert from 'node:assert/strict';
import { actionLabel, changeSummary, money, references } from '../js/activity-format.js';

test('cancellation activity explains restored and released inventory', () => {
  assert.match(changeSummary({ type: 'order.cancelled', detail: { changedFields: { status: { before: 'confirmed', after: 'cancelled' }, inventory: { kind: 'stock_restored', items: [{ itemName: 'Sweet A', unitSymbol: 'kg', onHandQtyRestored: 2000 }] } } } }), /Stock restored: Sweet A 2 kg/);
  assert.match(changeSummary({ type: 'order.draft_cancelled', detail: { changedFields: { inventory: { kind: 'reservation_released', items: [{ itemName: 'Sweet A', unitSymbol: 'kg', reservedQtyReleased: 1000 }] } } } }), /Reservation released: Sweet A 1 kg/);
});

test('activity labels support known and unknown legacy codes', () => {
  assert.equal(actionLabel('payment.verified'), 'Payment verified');
  assert.equal(actionLabel('order.invoice_created'), 'Invoice created');
  assert.equal(actionLabel('legacy_event-code'), 'Legacy Event Code');
});

test('activity changes format paise, statuses, modes and reasons without JSON', () => {
  const summary = changeSummary({ type: 'payment.mode_changed', changedFields: { amountPaise: { before: 0, after: 155000 }, mode: { before: 'upi', after: 'bank_transfer' }, verificationStatus: { before: 'unverified', after: 'verified' } }, reason: 'Bank statement matched' });
  assert.match(summary, /₹1,550\.00/);
  assert.match(summary, /UPI to Bank transfer/);
  assert.match(summary, /Pending verification to Verified/);
  assert.match(summary, /Reason: Bank statement matched/);
  assert.doesNotMatch(summary, /\{"before"/);
});

test('legacy stringified and malformed details remain safe', () => {
  assert.match(changeSummary({ type: 'order.edited', detail: '{"changedFields":{"grandTotal":{"before":251000,"after":155000}}}' }), /₹2,510\.00 to ₹1,550\.00/);
  assert.equal(changeSummary({ type: 'order.edited', detail: '{broken' }), 'Details updated');
  assert.equal(money(null), 'Not available');
  assert.equal(money(0), '₹0.00');
});

test('references use stored snapshots and never expose internal ids as business names', () => {
  const ref = references({ customerName: 'Asha', orderNumber: 'SS-42', invoiceNumber: 'INV-42', actorName: 'Hari' });
  assert.deepEqual(ref, { customer: 'Asha', order: 'SS-42', invoice: 'INV-42', actor: 'Hari', amount: undefined, mode: '' });
  assert.equal(references({ referenceId: 'internal-id' }).order, 'Not available');
});
