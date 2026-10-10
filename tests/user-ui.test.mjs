import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(mode) {
  const elements = new Map();
  const element = () => ({ children: [], hidden: true, value: '', checked: false, listeners: {}, classList: { toggle() {} }, append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; }, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {} });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const tab = element(); tab.dataset = { masterTab: 'users' };
  const writes = []; let failOnce = true;
  const context = {
    document: { getElementById: get, createElement: element, createTextNode: text => ({ textContent: text }), querySelectorAll: selector => selector === '[data-master-tab]' ? [tab] : [], addEventListener() {} },
    isStaff: profile => profile?.role === 'admin', MASTER_LABELS: { items: 'Item', users: 'User' },
    listMasterRecords: async () => [], readDashboardTarget: async () => '', showToast() {},
    crypto: { randomUUID: () => 'stable-user-operation' },
    FormData: class { [Symbol.iterator]() { return Object.entries({ fullName: 'New User', email: 'new@example.test', role: 'user' })[Symbol.iterator](); } },
    saveMasterRecord: async (_db, type, id, input) => { writes.push({ type, id, ...input }); if (failOnce) { failOnce = false; throw new Error('Retry setup'); } },
  };
  const source = readFileSync(new URL('../js/master-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initMasterData', 'function initMasterData');
  vm.runInNewContext(`${source}\nthis.init = initMasterData;`, context);
  context.init({ db: {}, functions: {}, mode }).setSession({ uid: 'admin' }, { role: 'admin', active: true });
  tab.listeners.click();
  return { get, writes };
}
test('live Add User remains disabled and programmatic clicks cannot open account creation', async () => {
  const { get } = fixture('live'); await get('master-refresh').listeners.click();
  assert.equal(get('master-add').disabled, true);
  await get('master-add').listeners.click();
  assert.notEqual(get('master-dialog').open, true);
});
test('emulator user form uses name/email without UID and preserves retry operation ID', async () => {
  const { get, writes } = fixture('emulator'); await get('master-refresh').listeners.click();
  assert.equal(get('master-add').disabled, false);
  await get('master-add').listeners.click();
  const names = get('master-form-fields').children.flatMap(wrapper => wrapper.children.map(child => child.name));
  assert.ok(names.includes('fullName')); assert.ok(names.includes('email')); assert.ok(!names.includes('uid'));
  const event = { preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ checked: true }) } } };
  await get('master-form').listeners.submit(event);
  assert.equal(get('master-dialog').open, true);
  await get('master-form').listeners.submit(event);
  assert.equal(writes[0].id, null); assert.equal(writes[0].operationId, writes[1].operationId);
  assert.equal(get('master-dialog').open, false);
});
