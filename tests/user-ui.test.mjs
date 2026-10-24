import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hasPermission } from '../js/permissions.js';

function fixture(mode, { role = 'admin', active = true, records = [], setupRequest } = {}) {
  const elements = new Map();
  const element = () => ({ children: [], hidden: true, value: '', checked: false, listeners: {}, classList: { toggle() {} }, append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; }, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {} });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const tab = element(); tab.dataset = { masterTab: 'users' };
  const writes = [], setupEmails = [], toasts = []; let failOnce = true;
  const context = {
    document: { getElementById: get, createElement: element, createTextNode: text => ({ textContent: text }), querySelector: selector => selector === '[data-master-tab="users"]' ? tab : null, querySelectorAll: selector => selector === '[data-master-tab]' ? [tab] : [], addEventListener() {} },
    hasPermission, isStaff: profile => profile?.active === true && ['admin', 'account_admin'].includes(profile.role), MASTER_LABELS: { items: 'Item', users: 'User' },
    listMasterRecords: async () => records, readDashboardTarget: async () => '', showToast: text => toasts.push(text),
    callOperation: async (_functions, name, payload) => { assert.equal(name, 'sendUserSetupLink'); setupEmails.push(payload.targetUid); return setupRequest ? setupRequest(payload) : { email: records.find(record => record.id === payload.targetUid).email }; },
    uniqueId: () => 'stable-user-operation',
    FormData: class { [Symbol.iterator]() { return Object.entries({ fullName: 'New User', email: 'new@example.test', role: 'user' })[Symbol.iterator](); } },
    saveMasterRecord: async (_db, type, id, input) => { writes.push({ type, id, ...input }); if (failOnce) { failOnce = false; throw new Error('Retry setup'); } },
  };
  const source = readFileSync(new URL('../js/master-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initMasterData', 'function initMasterData');
  vm.runInNewContext(`${source}\nthis.init = initMasterData;`, context);
  context.init({ db: {}, functions: {}, mode }).setSession({ uid: 'actor' }, { role, active });
  tab.listeners.click();
  return { get, tab, writes, setupEmails, toasts };
}
test('live Admin can open Add User through the trusted callable flow', async () => {
  const { get } = fixture('live', { role: 'admin' }); await get('master-refresh').listeners.click();
  assert.equal(get('master-add').disabled, false);
  await get('master-add').listeners.click();
  assert.equal(get('master-dialog').open, true);
});
test('Account Admin can open live User management with the restricted role flow', async () => {
  for (const role of ['account_admin']) {
    const { get } = fixture('live', { role });
    await get('master-add').listeners.click();
    assert.equal(get('master-dialog').open, true);
  }
});
test('ordinary or inactive users cannot open Add User, even by calling the click handler', async () => {
  for (const options of [{ role: 'user' }, { role: 'admin', active: false }]) {
    const { get } = fixture('live', options);
    await get('master-add').listeners.click();
    assert.notEqual(get('master-dialog').open, true);
  }
});
test('production Admin can request password setup for an active account', async () => {
  const { get, setupEmails } = fixture('live', { role: 'admin', records: [{ id: 'target', email: 'target@example.test', fullName: 'Target', role: 'user', active: true }] });
  await get('master-refresh').listeners.click();
  const actions = get('master-table-body').children[0].children.at(-1);
  const setup = actions.children.find(button => button.textContent.includes('Send Setup Link'));
  assert.ok(setup);
  await setup.listeners.click();
  assert.deepEqual(setupEmails, ['target']);
  assert.match(get('master-mobile-list').innerHTML, /Send Setup Link/);
});
test('mobile setup action uses the UID, blocks repeat taps, and reports failure', async () => {
  let resolveRequest;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const { get, setupEmails, toasts } = fixture('live', { records: [{ id: 'target', email: 'target@example.test', fullName: 'Target', role: 'user', active: true }], setupRequest: async () => { await pending; throw new Error('Email service unavailable'); } });
  await get('master-refresh').listeners.click();
  const button = { dataset: { masterAction: 'setup', id: 'target' }, textContent: '✉ Send Setup Link', disabled: false };
  const click = () => get('master-mobile-list').listeners.click({ target: { closest: () => button } });
  click(); click();
  assert.deepEqual(setupEmails, ['target']);
  assert.equal(button.disabled, true);
  resolveRequest();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(button.disabled, false);
  assert.match(get('master-message').textContent, /Email service unavailable/);
  assert.equal(toasts.length, 0);
});
test('Account Admin sees setup for Users only; inactive accounts keep reactivation', async () => {
  const { get } = fixture('live', { role: 'account_admin', records: [
    { id: 'staff', email: 'staff@example.test', fullName: 'Staff', role: 'admin', active: true },
    { id: 'target', email: 'target@example.test', fullName: 'Target', role: 'user', active: true },
    { id: 'inactive', email: 'inactive@example.test', fullName: 'Inactive', role: 'user', active: false },
  ] });
  await get('master-refresh').listeners.click();
  const cards = get('master-mobile-list').innerHTML;
  assert.match(cards, /data-id="target"[^>]*>✉ Send Setup Link/);
  assert.doesNotMatch(cards, /data-id="staff"[^>]*>✉ Send Setup Link|data-id="inactive"[^>]*>✉ Send Setup Link/);
  assert.match(cards, /data-master-action="reactivate" data-id="inactive"/);
});
test('user form keeps a failed save open, includes optional password setup, and reuses the operation ID on retry', async () => {
  const { get, writes } = fixture('live', { role: 'admin' }); await get('master-refresh').listeners.click();
  assert.equal(get('master-add').disabled, false);
  await get('master-add').listeners.click();
  const names = get('master-form-fields').children.flatMap(wrapper => wrapper.children.map(child => child.name));
  assert.ok(names.includes('fullName')); assert.ok(names.includes('email')); assert.ok(names.includes('password')); assert.ok(!names.includes('uid'));
  const event = { preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ checked: true }) } } };
  await get('master-form').listeners.submit(event);
  assert.equal(get('master-dialog').open, true);
  await get('master-form').listeners.submit(event);
  assert.equal(writes[0].id, null); assert.equal(writes[0].operationId, writes[1].operationId);
  assert.equal(get('master-dialog').open, false);
});
test('emulator Admin retains Add User access', async () => {
  const { get } = fixture('emulator', { role: 'admin' }); await get('master-refresh').listeners.click();
  assert.equal(get('master-add').disabled, false);
  await get('master-add').listeners.click();
  assert.equal(get('master-dialog').open, true);
});
