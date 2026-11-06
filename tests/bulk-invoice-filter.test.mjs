import test from 'node:test';
import assert from 'node:assert/strict';
import { assignedInvoiceUser, visibleBulkInvoices } from '../js/bulk-invoice-filter.js';
import { eligibleCollectionInvoice } from '../js/collection-eligibility.js';

test('bulk invoice assignment follows linked order ID and handles legacy records', () => {
  const orders = new Map([
    ['o1', { assignedUserId: 'u2', ownerUid: 'u1' }],
    ['o2', { ownerUid: 'u1' }],
  ]);
  assert.equal(assignedInvoiceUser({ id: 'o1', ownerUid: 'u1' }, orders), 'u2');
  assert.equal(assignedInvoiceUser({ id: 'o2', ownerUid: 'u2' }, orders), 'u1');
  assert.equal(assignedInvoiceUser({ id: 'missing', ownerUid: 'u1' }, orders), '');
});

test('assigned user combines with status, search and eligibility without matching similar names', () => {
  const rows = [
    { id: 'a', assignedUserId: 'u1', invoiceNumber: 'INV-100', customerId: 'c', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 5000 },
    { id: 'b', assignedUserId: 'u1', invoiceNumber: 'INV-101', customerId: 'c', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 0 },
    { id: 'c', assignedUserId: 'u2', invoiceNumber: 'INV-100', customerId: 'c', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 5000 },
    { id: 'd', assignedUserId: '', invoiceNumber: 'INV-100', customerId: 'c', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 5000 },
    { id: 'e', assignedUserId: 'u1', invoiceNumber: 'INV-100', customerId: 'c', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 10000 },
  ];
  assert.deepEqual(visibleBulkInvoices(rows, { owner: 'u1', status: 'partial', number: '100', customer: 'ash' }, eligibleCollectionInvoice).map((row) => row.id), ['a']);
  assert.deepEqual(visibleBulkInvoices(rows, { owner: 'u3' }, eligibleCollectionInvoice), []);
  assert.deepEqual(visibleBulkInvoices(rows, { owner: '' }, eligibleCollectionInvoice).map((row) => row.id), ['a', 'b', 'c', 'd']);
});
