import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueId } from '../js/unique-id.js';

test('uses native randomUUID in a secure context', () => {
  const expected = '00000000-0000-4000-8000-000000000001';
  const source = { randomUUID: () => expected, getRandomValues: () => { throw new Error('fallback should not run'); } };
  assert.equal(uniqueId(source, true), expected);
});

test('uses cryptographic random bytes for a version 4 UUID on HTTP LAN pages', () => {
  let calls = 0;
  const source = {
    randomUUID: () => { throw new Error('insecure native path should not run'); },
    getRandomValues(bytes) { bytes.fill(calls++); return bytes; },
  };
  const first = uniqueId(source, false);
  const second = uniqueId(source, false);
  assert.equal(first, '00000000-0000-4000-8000-000000000000');
  assert.equal(second, '01010101-0101-4101-8101-010101010101');
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('fails closed when no cryptographic random source exists', () => {
  assert.throws(() => uniqueId({}, false), /Secure random IDs are unavailable/);
});
