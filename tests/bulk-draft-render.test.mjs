import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkDraftHtml } from '../js/bulk-draft-render.js';
import { eligibleCollectionInvoice } from '../js/collection-eligibility.js';

const invoices = [
  { id: 'a', invoiceNumber: 'INV-101', customerId: 'c1', customerSnapshot: { fullName: 'Alice' }, ownerUid: 'u1', totalPaise: 10000, verifiedPaidPaise: 0, paymentStatus: 'unpaid' },
  { id: 'b', invoiceNumber: 'INV-102', customerId: 'c1', customerSnapshot: { fullName: 'Alice' }, ownerUid: 'u1', totalPaise: 9000, verifiedPaidPaise: 4000, paymentStatus: 'partial' },
  { id: 'c', invoiceNumber: 'INV-201', customerId: 'c2', customerSnapshot: { fullName: 'Bob' }, ownerUid: 'u2', totalPaise: 7000, verifiedPaidPaise: 0, paymentStatus: 'unpaid' },
  { id: 'd', invoiceNumber: 'INV-202', customerId: 'c2', customerSnapshot: { fullName: 'Bob' }, ownerUid: 'u2', totalPaise: 7000, verifiedPaidPaise: 7000, paymentStatus: 'paid' },
];
const base = () => ({ allocations: new Map(), filters: { owner: '', number: '', customer: '', status: '' }, entries: [{ mode: 'cash', amountPaise: 0, amountRaw: '0.00', transactionNumber: '', file: null }], remarks: '', invoiceLoading: false, invoiceError: false });
const html = (draft) => bulkDraftHtml({ draft, invoices, names: new Map([['u1', 'Worker One'], ['u2', 'Worker Two']]), eligible: eligibleCollectionInvoice, reference: 'COL-TEST', collectionDate: '2026-10-31', collectedBy: 'Worker One' });

test('invoice picker lists outstanding invoices across customers and excludes paid invoices', () => {
  const result = html(base());
  assert.match(result, /INV-101/); assert.match(result, /INV-102/); assert.match(result, /INV-201/); assert.doesNotMatch(result, /INV-202/);
  assert.match(result, /Worker One/); assert.match(result, /Worker Two/);
  assert.match(result, /Select All visible/); assert.match(result, /Deselect All/);
  assert.match(result, /collection-submit[^>]*disabled/);
});

test('invoice filters support owner, partial status, and exact or partial invoice number', () => {
  const draft = base(); draft.filters = { owner: 'u1', number: '102', customer: 'Ali', status: 'partial' };
  const result = html(draft);
  assert.match(result, /data-invoice-check="b"/); assert.doesNotMatch(result, /data-invoice-check="a"/); assert.doesNotMatch(result, /data-invoice-check="c"/);
});

test('selected invoice amount and payment entry must reconcile before submit', () => {
  const draft = base(); draft.allocations.set('a', { amountPaise: 3000, paymentIndex: 0 }); draft.entries[0].amountPaise = 3000;
  assert.doesNotMatch(html(draft), /collection-submit[^>]*disabled/);
  draft.entries[0].amountPaise = 2000;
  assert.match(html(draft), /collection-submit[^>]*disabled/);
});
