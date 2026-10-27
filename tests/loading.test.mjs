import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoading, stopLoading, loadingCount, withLoading, withReadTimeout } from '../js/loading.js';

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

test('slow request can uncover the form while its token remains active', () => {
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let slowCallback;
  const message = { textContent: '' }, slow = { hidden: true }, dismiss = { hidden: true, onclick: null };
  const overlay = { hidden: true, open: false, dataset: {}, setAttribute() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  const nodes = { 'global-loader': overlay, 'global-loader-message': message, 'global-loader-slow': slow, 'global-loader-dismiss': dismiss };
  globalThis.document = { getElementById: (id) => nodes[id], documentElement: { classList: { toggle() {} } } };
  globalThis.setTimeout = (callback) => { slowCallback = callback; return 1; };
  globalThis.clearTimeout = () => {};
  try {
    const token = startLoading('Saving order…');
    assert.equal(overlay.open, true);
    assert.equal(message.textContent, 'Saving order…');
    slowCallback();
    assert.equal(slow.hidden, false);
    dismiss.onclick();
    assert.equal(overlay.open, false);
    assert.equal(loadingCount(), 1);
    stopLoading(token);
    assert.equal(loadingCount(), 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('read timeout stops waiting without changing write tokens', async () => {
  await assert.rejects(withReadTimeout(() => new Promise(() => {}), 5, 'Read timed out.'), /Read timed out/);
  assert.equal(await withReadTimeout(() => Promise.resolve('fresh'), 50), 'fresh');
  assert.equal(loadingCount(), 0);
});
