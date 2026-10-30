import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsXlsxBlob, safeSpreadsheetRows, safeSpreadsheetValue } from '../js/xlsx-export.js';
import { openAnalyticsExport, shareAnalyticsFile } from '../js/analytics-share.js';

test('spreadsheet export neutralizes formula-like customer and log fields', () => {
  for (const value of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '  =HYPERLINK("x")', '\t=1']) {
    assert.equal(safeSpreadsheetValue(value), `'${value}`);
  }
  assert.deepEqual(safeSpreadsheetRows([{ Customer: '=BAD()', Amount: 125, Date: '10/10/2026' }]), [{ Customer: "'=BAD()", Amount: 125, Date: '10/10/2026' }]);
});

test('Excel share opens native file sharing synchronously and cancellation is harmless', async () => {
  const file = new File(['xlsx'], 'hiren_siddhpura.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  let payload, checked = false;
  const browser = { canShare: ({ files }) => { assert.equal(files[0], file); checked = true; return true; }, share: (value) => { assert.ok(checked); payload = value; return Promise.resolve(); } };
  const result = shareAnalyticsFile(file, { navigator: browser, download: () => assert.fail('unexpected download') });
  assert.equal(payload.files[0], file, 'share is called before yielding user activation');
  assert.equal(await result, 'shared');
  browser.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); };
  assert.equal(await shareAnalyticsFile(file, { navigator: browser }), 'cancelled');
  browser.share = async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); };
  await assert.rejects(shareAnalyticsFile(file, { navigator: browser }), /Download Excel/);
});

test('unsupported Excel sharing downloads the same file without claiming attachment', async () => {
  const file = new File(['xlsx'], 'user_orders.xlsx');
  for (const browser of [{}, { canShare: () => false, share: () => assert.fail() }, { canShare: () => { throw new Error('unsupported'); }, share: () => assert.fail() }]) {
    let downloads = 0;
    assert.equal(await shareAnalyticsFile(file, { navigator: browser, download: (blob, name) => { assert.equal(blob, file); assert.equal(name, file.name); downloads++; } }), 'downloaded');
    assert.equal(downloads, 1);
  }
});

test('Excel Blob uses XLSX binary output and preserves the existing worksheet values', async () => {
  const previous = globalThis.window;
  let values, format;
  globalThis.window = { XLSX: { utils: { book_new: () => ({}), aoa_to_sheet: (rows) => { values = rows; return {}; }, encode_cell: () => 'C2', book_append_sheet() {} }, write: (_, options) => { format = options; return new Uint8Array([80, 75, 3, 4]); } } };
  try {
    const blob = await analyticsXlsxBlob({ filename: 'a.xlsx', headers: ['Phone', 'Item (KG)', 'Total'], rows: [['00123', 1.25, '1.25 KG'], ['TOTAL', 1.25, '1.25 KG']] });
    assert.deepEqual(format, { bookType: 'xlsx', type: 'array' });
    assert.equal(values[1][0], '00123');
    assert.equal(values[1][1], 1.25);
    assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(blob.size, 4);
  } finally { globalThis.window = previous; }
});

test('report dialog prepares before sharing, blocks duplicate taps and rejects changed sessions', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const nodes = new Map(), listeners = {};
  const node = (key) => { if (!nodes.has(key)) nodes.set(key, { disabled: true, textContent: '' }); return nodes.get(key); };
  const dialog = { isConnected: true, setAttribute() {}, querySelector: node, addEventListener: (key, callback) => { listeners[key] = callback; }, showModal() {}, close: () => listeners.close(), remove() { this.isConnected = false; } };
  let shares = 0, completeShare, allowed = true;
  globalThis.window = { XLSX: { utils: { book_new: () => ({}), aoa_to_sheet: () => ({}), encode_cell: () => 'A2', book_append_sheet() {} }, write: () => new Uint8Array([80, 75]) } };
  globalThis.document = { createElement: () => dialog, body: { append() {} } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { canShare: () => true, share: () => { shares++; return new Promise((resolve) => { completeShare = resolve; }); } } });
  try {
    const finished = openAnalyticsExport({ filename: 'user.xlsx', headers: ['User'], rows: [['User'], ['TOTAL']] }, { isAuthorized: () => allowed });
    await new Promise((resolve) => setImmediate(resolve));
    const share = node('[data-share]');
    assert.equal(share.disabled, false);
    const sharing = share.onclick();
    await share.onclick();
    assert.equal(shares, 1);
    assert.equal(node('[data-close]').disabled, true);
    completeShare(); await sharing;
    allowed = false;
    await share.onclick();
    assert.equal(shares, 1);
    assert.match(node('[role="status"]').textContent, /session changed/);
    node('[data-close]').onclick(); await finished;
    assert.equal(dialog.isConnected, false);
  } finally {
    globalThis.window = oldWindow; globalThis.document = oldDocument;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  }
});
