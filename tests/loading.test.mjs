import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoading, stopLoading, loadingCount, withLoading } from '../js/loading.js';

test('loading manager keeps overlapping operations visible until all finish', async () => {
  while (loadingCount()) stopLoading('missing');
  const first = startLoading('Saving your order…');
  const second = startLoading('Creating invoice…');
  assert.equal(loadingCount(), 2);
  stopLoading(first);
  assert.equal(loadingCount(), 1);
  stopLoading(second);
  assert.equal(loadingCount(), 0);
});

test('withLoading always releases after success and failure', async () => {
  await withLoading(async () => 'ok', 'Loading…');
  assert.equal(loadingCount(), 0);
  await assert.rejects(withLoading(async () => { throw new Error('failed'); }, 'Saving…'), /failed/);
  assert.equal(loadingCount(), 0);
});
