import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleCollectionInvoice } from '../js/collection-eligibility.js';

const invoice = (overrides = {}) => ({ customerId: 'customerA', totalPaise: 10000, verifiedPaidPaise: 0, paymentStatus: 'unpaid', ...overrides });

test('bulk collection eligibility includes unpaid and partial balances across customers', () => {
  const rows = [invoice(), invoice({ verifiedPaidPaise: 3000, paymentStatus: 'partial' }), invoice({ customerId: 'customerB', totalPaise: 5000 })];
  assert.equal(rows.filter(eligibleCollectionInvoice).length, 3);
});

test('bulk collection eligibility excludes paid, cancelled, pending, overpaid and invalid balances', () => {
  const rows = [invoice({ verifiedPaidPaise: 10000, paymentStatus: 'paid' }), invoice({ paymentStatus: 'cancelled' }), invoice({ status: 'cancelled' }), invoice({ paymentStatus: 'in_process' }), invoice({ paymentStatus: 'overpaid' }), invoice({ verifiedPaidPaise: undefined }), invoice({ customerId: '' })];
  assert.equal(rows.filter(eligibleCollectionInvoice).length, 0);
});
