import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingPaymentGroups } from '../js/pending-payment.js';

test('groups outstanding invoice balances and excludes completed invoices', () => {
  const invoices = [
    { id: 'a', ownerUid: 'u', totalPaise: 20000, verifiedPaidPaise: 5000, paymentStatus: 'partial' },
    { id: 'b', ownerUid: 'u', totalPaise: 10000, verifiedPaidPaise: 0, paymentStatus: 'in_process' },
    { id: 'c', ownerUid: 'u', totalPaise: 5000, verifiedPaidPaise: 5000, paymentStatus: 'paid' },
    { id: 'd', ownerUid: 'u', totalPaise: 5000, verifiedPaidPaise: 0, status: 'cancelled' },
  ];
  const [group] = pendingPaymentGroups(invoices, [{ id: 'u', displayName: 'Jaimin Gajjar' }]);
  assert.equal(group.userName, 'Jaimin Gajjar');
  assert.equal(group.count, 2);
  assert.equal(group.amountPaise, 25000);
  assert.deepEqual(group.invoices.map((invoice) => invoice.remainingPaise), [15000, 10000]);
  assert.deepEqual(pendingPaymentGroups([]), []);
});

test('uses the current order assignee instead of the invoice owner or creator', () => {
  const groups = pendingPaymentGroups(
    [{ id: 'invoice', orderId: 'order', ownerUid: 'original', createdBy: 'admin', totalPaise: 1750000, verifiedPaidPaise: 0, paymentStatus: 'unpaid' }],
    [{ id: 'assigned', displayName: 'Jaimin Gajjar' }],
    [{ id: 'order', ownerUid: 'original', assignedUserId: 'assigned' }],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].userId, 'assigned');
  assert.equal(groups[0].userName, 'Jaimin Gajjar');
  assert.equal(groups[0].amountPaise, 1750000);
});
