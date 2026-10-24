import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/activity-data.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/, 'const { collection, getDocs, limit, orderBy, query, startAfter, where } = globalThis.__activityFirestore;\n');

async function adapter(firestore) {
  globalThis.__activityFirestore = firestore;
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`); }
  finally { delete globalThis.__activityFirestore; }
}

const calls = [];
const firestore = (result) => ({
  collection: (_db, name) => ({ name }),
  where: (...args) => ({ kind: 'where', args }), orderBy: (...args) => ({ kind: 'orderBy', args }),
  startAfter: (...args) => ({ kind: 'startAfter', args }), limit: (...args) => ({ kind: 'limit', args }),
  query: (_collection, ...constraints) => ({ constraints }),
  getDocs: async (value) => { calls.push(value); return result; },
});

test('activity adapter returns human-readable event snapshots and applies an owner query for Users', async () => {
  calls.length = 0;
  const snapshot = { id: 'eventA', data: () => ({ referenceType: 'order', referenceId: 'orderA', ownerUid: 'userA', actorName: 'Admin', customerName: 'Asha', type: 'order.confirmed', at: { toDate: () => new Date('2026-10-10T00:00:00Z') } }) };
  const { listActivity } = await adapter(firestore({ empty: false, size: 1, docs: [snapshot] }));
  const result = await listActivity({}, { role: 'user', active: true }, 'userA', 'order');
  assert.equal(result.rows[0].actorName, 'Admin');
  assert.equal(result.rows[0].orderId, 'orderA');
  assert.equal(calls[0].constraints.some((entry) => entry.kind === 'where' && entry.args[0] === 'ownerUid' && entry.args[2] === 'userA'), true);
});

test('activity adapter distinguishes empty results, inactive access, and backend failures', async () => {
  const empty = await adapter(firestore({ empty: true, size: 0, docs: [] }));
  assert.deepEqual(await empty.listActivity({}, { role: 'admin', active: true }, 'adminA', 'payment'), { rows: [], cursor: null, hasMore: false });
  await assert.rejects(empty.listActivity({}, { role: 'user', active: false }, 'userA', 'order'), /Active OMS access/);
  const failing = await adapter({ ...firestore({}), getDocs: async () => { const error = new Error('network unavailable'); error.code = 'unavailable'; throw error; } });
  await assert.rejects(failing.listActivity({}, { role: 'admin', active: true }, 'adminA', 'order'), /network unavailable/);
});
