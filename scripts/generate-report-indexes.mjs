import { writeFileSync } from 'node:fs';

// Keep this list aligned with the server-side queries in js/reporting-data.js.
const indexes = [];
const add = (collectionGroup, equality, ordered, directions = ['ASCENDING', 'DESCENDING']) => {
  for (const direction of directions) {
    indexes.push({ collectionGroup, queryScope: 'COLLECTION', fields: [
      ...equality.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })),
      ...ordered.map((fieldPath) => ({ fieldPath, order: direction })),
    ] });
  }
};
const subsets = (fields) => Array.from({ length: 2 ** fields.length }, (_, mask) =>
  fields.filter((_, index) => mask & (1 << index)));

for (const eq of subsets(['ownerUid', 'periodType', 'active'])) {
  if (eq.length) add('targets', eq, ['periodStart']);
}
add('targets', ['ownerUid', 'active'], ['periodStart', 'periodEnd'], ['DESCENDING']);
for (const eq of subsets(['active', 'audience'])) {
  if (eq.length) add('announcements', eq, ['startsOn']);
  // Prefix search uses a titleKey range; optional startsOn date bounds add
  // a second range field. Firestore's leftmost ordering follows titleKey.
  add('announcements', eq, ['titleKey']);
  add('announcements', eq, ['titleKey', 'startsOn']);
}
add('announcements', ['active'], ['startsOn', 'expiresOn'], ['DESCENDING']);
add('announcements', ['active', 'audience'], ['startsOn', 'expiresOn'], ['DESCENDING']);
for (const eq of subsets(['uid', 'type'])) {
  if (eq.length) add('loginLogs', eq, ['at']);
}
for (const eq of subsets(['actorUid', 'type', 'referenceId'])) {
  if (eq.length) add('auditLogs', eq, ['at']);
}
add('orders', ['ownerUid'], ['orderDate']);
add('orders', [], ['orderDate', 'grandTotal'], ['ASCENDING']);
add('orders', ['ownerUid'], ['orderDate', 'grandTotal'], ['ASCENDING']);
add('orders', ['ownerUid'], ['createdAt'], ['DESCENDING']);
add('orders', ['ownerUid', 'status'], ['confirmedAt']);
add('orders', ['ownerUid', 'status'], ['confirmedAt', 'grandTotal'], ['ASCENDING']);
add('payments', ['ownerUid', 'verificationStatus'], []);
add('invoices', ['ownerUid'], ['totalPaise', 'verifiedPaidPaise']);
add('invoices', ['ownerUid'], ['totalPaise'], ['ASCENDING']);
add('invoices', ['ownerUid'], ['verifiedPaidPaise'], ['ASCENDING']);

const unique = [...new Map(indexes.filter((entry) => entry.fields.length > 1)
  .map((entry) => [JSON.stringify(entry), entry])).values()];
writeFileSync(new URL('../firestore.indexes.json', import.meta.url),
  `${JSON.stringify({ indexes: unique, fieldOverrides: [] }, null, 2)}\n`);
console.log(`Wrote ${unique.length} reporting indexes.`);
