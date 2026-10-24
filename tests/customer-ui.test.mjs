import { hasPermission, validateProfile } from '../js/permissions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';
import { customerSaveError, validateCustomerInput } from '../js/customer-validation.js';

test('customer form shows Firestore denial, keeps the dialog open and reuses the submission ID', async () => {
  const elements = new Map(), submittedIds = []; let callableRequests = 0;
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', hidden: false, listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const fields = new Map(Object.entries({ fullName: 'Local customer', contact: '9876543210', address: 'Street', area: 'Area', dateOfBirth: '', sabha: 'false' }));
  const context = { validateProfile, hasPermission, validateCustomerInput,
    document: { getElementById: getElement, addEventListener() {}, querySelector: () => null },
    isStaff: (profile) => profile?.role === 'admin', showToast() {}, customerSaveError,
    uniqueId: () => 'stable-customer-submission', FormData: class { get(name) { return fields.get(name); } },
    saveCustomerDirect: async (_db, _auth, _data, options) => { submittedIds.push(options.customerId); throw { code: 'permission-denied' }; },
    callOperation: async () => { callableRequests++; },
  };
  const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');
  vm.runInNewContext(`${source}\nthis.init = initOrderUi;`, Object.assign(context, { availableOrderUnits, itemUnitPrice, orderLineUnitLabel }));
  context.init({ db: {}, auth: { currentUser: { uid: 'admin' } }, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin' });
  getElement('customer-new').listeners.click();
  for (let retry = 0; retry < 2; retry++) await getElement('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(getElement('order-dialog').open, true);
  assert.equal(getElement('order-form-error').hidden, false);
  assert.match(getElement('order-form-error').textContent, /Firestore denied saving/);
  assert.deepEqual(submittedIds, ['stable-customer-submission', 'stable-customer-submission']);
  assert.equal(callableRequests, 0);
  assert.equal(getElement('order-dialog-save').disabled, false);
});

test('customer field validation allows a blank address and defaults removed fields', () => {
  const valid = { fullName: ' Name ', contact: '9876543210', address: 'Street', area: 'West', dateOfBirth: '2024-02-29', sabha: false };
  assert.equal(validateCustomerInput(valid).fullName, 'Name');
  assert.equal(validateCustomerInput({ ...valid, address: ' ' }).address, '');
  assert.deepEqual(validateCustomerInput({ fullName: 'Name', contact: '9876543210', address: '', area: 'West' }), { fullName: 'Name', contact: '9876543210', address: '', area: 'West', dateOfBirth: null, sabha: false });
  for (const field of ['fullName', 'contact', 'area']) assert.throws(() => validateCustomerInput({ ...valid, [field]: ' ' }), /required/);
  assert.throws(() => validateCustomerInput({ ...valid, dateOfBirth: '2026-02-29' }), /valid date/);
  assert.throws(() => validateCustomerInput({ ...valid, dateOfBirth: 0 }), /valid date/);
});

test('Delete confirms the escaped name and preserves the exact dependency error without direct writes', async () => {
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const linkedMessage = 'Cannot delete this customer because transaction records are linked to them.';
  const context = { validateProfile, hasPermission,
    document: { getElementById: element, addEventListener() {}, querySelector: () => null },
    isStaff: profile => ['admin', 'account_admin'].includes(profile?.role), showToast() {},
    FormData: class {}, listCustomers: async () => [{ id: 'customer', fullName: 'Name <private>', contact: '9876543210' }], listMasterRecords: async () => [],
    callOperation: async (_functions, name, payload) => { requests.push({ name, payload }); throw new Error(linkedMessage); },
    saveCustomerDirect: () => { throw new Error('Deletion must not use direct writes.'); },
  };
  const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');
  vm.runInNewContext(`${source}\nthis.init = initOrderUi;`, Object.assign(context, { availableOrderUnits, itemUnitPrice, orderLineUnitLabel }));
  const ui = context.init({ db: {}, functions: {}, mode: 'live' });
  ui.setSession({ uid: 'admin' }, { role: 'admin' });
  await element('customer-refresh').listeners.click();
  assert.doesNotMatch(element('customer-body').innerHTML, /data-action="deleteCustomer"/);
  const emulatorUi = context.init({ db: {}, functions: {}, mode: 'emulator' });
  emulatorUi.setSession({ uid: 'admin' }, { role: 'admin', active: true });
  await element('customer-refresh').listeners.click();
  assert.match(element('customer-body').innerHTML, /data-action="deleteCustomer"/);
  element('customer-body').listeners.click({ target: { closest: () => ({ dataset: { action: 'deleteCustomer', id: 'customer' } }) } });
  assert.match(element('order-fields').innerHTML, /Name &lt;private&gt;/);
  assert.equal(element('order-dialog-save').textContent, 'Delete customer');
  await element('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(requests[0].name, 'deleteCustomer');
  assert.equal(requests[0].payload.customerId, 'customer');
  assert.equal(element('order-form-error').textContent, linkedMessage);
  assert.equal(element('order-dialog').open, true);
  assert.equal(element('order-dialog-save').disabled, false);
  emulatorUi.setSession({ uid: 'user' }, { role: 'user' });
  element('customer-body').listeners.click({ target: { closest: () => ({ dataset: { action: 'deleteCustomer', id: 'customer' } }) } });
  assert.equal(requests.length, 1);
});
