import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hasPermission, isStaff } from '../js/permissions.js';
import { paymentInvoiceSummary, paymentUpload } from '../js/payment-form-ui.js';

test('payment status displays resolved names, safe fallbacks and names in export', async () => {
  const elements = new Map(), exports = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} }); return elements.get(id); };
  const payment = { id: 'paymentA', invoiceNumber: 'INV-1', orderNumber: 'SS-1', customerSnapshot: null, amountPaise: 1000, mode: 'cash', transactionNumber: '-', submittedBy: 'submitter', verifiedBy: 'verifier', verificationStatus: 'verified', submittedAt: { seconds: 1, toDate: () => new Date('2026-10-11T10:00:00Z') } };
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [], listPayments: async () => [payment], callOperation: async (_functions, name) => { assert.equal(name, 'getPaymentNames'); return { payments: [{ paymentId: 'paymentA', customerName: 'Asha', submittedByName: 'Submitting User', verifiedByName: 'Verifying Admin' }] }; }, downloadXlsx: async (_name, sheets) => { exports.push(sheets); } };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'submitter' }, { role: 'user', active: true, fullName: 'Submitting User' });
  for (let i = 0; i < 10 && !element('payment-body').innerHTML.includes('Verifying Admin'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('payment-body').innerHTML, /Asha/);
  assert.match(element('payment-body').innerHTML, /Submitting User/);
  assert.match(element('payment-body').innerHTML, /Verifying Admin/);
  assert.doesNotMatch(element('payment-body').innerHTML, />verifier</);
  assert.doesNotMatch(element('payment-body').innerHTML, /paymentA/);
  assert.doesNotMatch(element('payment-body').innerHTML, /data-finance="verify"/);
  assert.match(element('payment-cards').innerHTML, /Online collection \(verified\)/);
  assert.match(element('payment-cards').innerHTML, /Cash collection \(verified\)/);
  await element('payment-export').listeners.click();
  assert.equal(exports[0][0][1][0].SubmittedBy, 'Submitting User');
  assert.equal(exports[0][0][1][0].Verifier, 'Verifying Admin');
  assert.equal(Object.hasOwn(exports[0][0][1][0], 'PaymentID'), false);
});

test('payment table pages 25 rows while export includes every authorized filtered row', async () => {
  const elements = new Map(), exports = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} }); return elements.get(id); };
  const payments = Array.from({ length: 30 }, (_, index) => ({ id: `payment${index}`, invoiceNumber: 'INV-1', orderNumber: 'SS-1', customerSnapshot: { fullName: 'Asha' }, amountPaise: 100, mode: 'cash', transactionNumber: '-', submittedBy: 'userA', verificationStatus: 'unverified', submittedAt: { seconds: index + 1, toDate: () => new Date('2026-10-11T10:00:00Z') } }));
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [], listPayments: async () => payments, callOperation: async () => ({ payments: [] }), downloadXlsx: async (_name, sheets) => exports.push(sheets) };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  const ui = context.init({ db: {}, functions: {} });
  ui.setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('payment-body').innerHTML.includes('payment29'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((element('payment-body').innerHTML.match(/<tr>/g) || []).length, 25);
  await element('payment-export').listeners.click();
  assert.equal(exports[0][0][1].length, 30);
  assert.equal(Object.hasOwn(exports[0][0][1][0], 'PaymentID'), false);
});

test('invoice remains visible when payment list fails, with a separate payment error', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} }); return elements.get(id); };
  const invoice = { id: 'orderA', invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', ownerUid: 'userA', customerSnapshot: { fullName: 'Asha' }, totalPaise: 1000, verifiedPaidPaise: 0, paymentStatus: 'unpaid' };
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [invoice], listPayments: async () => { throw new Error('permission-denied'); }, callOperation: async () => ({ payments: [] }), downloadXlsx: async () => {} };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('INV-SS-1'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('invoice-body').innerHTML, /INV-SS-1/);
  assert.doesNotMatch(element('invoice-body').innerHTML, /Add payment/);
  assert.match(element('invoice-message').textContent, /Could not check payment submissions/);
  assert.match(element('payment-message').textContent, /permission-denied/);
});

test('paid invoice status remains paid when an older pending payment is still in the payment list', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} }); return elements.get(id); };
  const invoice = { id: 'orderA', invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', ownerUid: 'userA', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 10000, paymentStatus: 'paid' };
  const payment = { id: 'old-pending', invoiceId: 'orderA', verificationStatus: 'unverified' };
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [invoice], listPayments: async () => [payment], callOperation: async () => ({ payments: [] }), downloadXlsx: async () => {} };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('INV-SS-1'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('invoice-body').innerHTML, /status-badge is-paid">Paid<\/span>/);
  assert.doesNotMatch(element('invoice-body').innerHTML, /In process|Add payment/);
  element('invoice-status').value = 'paid';
  element('invoice-status').listeners.input();
  assert.match(element('invoice-body').innerHTML, /INV-SS-1/);
});

test('fully verified legacy invoice appears paid without another approval action', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} }); return elements.get(id); };
  const invoice = { id: 'orderA', invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', ownerUid: 'userA', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 10000, paymentStatus: 'ready_to_mark_paid' };
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [invoice], listPayments: async () => [], callOperation: async () => ({ payments: [] }), downloadXlsx: async () => {} };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('INV-SS-1'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('invoice-body').innerHTML, /status-badge is-paid">Paid<\/span>/);
  assert.doesNotMatch(element('invoice-body').innerHTML, /Mark as Paid/);
});

test('pending payment shows In process, hides Add payment, and collection cards count verified funds only', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} });
    return elements.get(id);
  };
  const invoice = { id: 'orderA', invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', ownerUid: 'userA', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 5000, paymentStatus: 'unpaid' };
  const payments = [
    { id: 'pending', invoiceId: 'orderA', mode: 'upi', amountPaise: 5000, verificationStatus: 'unverified' },
    { id: 'cash', invoiceId: 'orderA', mode: 'cash', amountPaise: 3000, verificationStatus: 'verified' },
    { id: 'online', invoiceId: 'orderA', mode: 'bank_transfer', amountPaise: 2000, verificationStatus: 'verified' },
    { id: 'reversed', invoiceId: 'orderA', mode: 'upi', amountPaise: 1000, verificationStatus: 'verified', reversalId: 'reversal' },
  ];
  const context = { document: { getElementById: element, addEventListener() {} }, isStaff, hasPermission, showToast() {}, listInvoices: async () => [invoice], listPayments: async () => payments, callOperation: async () => ({ payments: [] }), downloadXlsx: async () => {} };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  const ui = context.init({ db: {}, functions: {} });
  ui.setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('In process'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('invoice-body').innerHTML, /In process/);
  assert.doesNotMatch(element('invoice-body').innerHTML, /Add payment/);
  assert.match(element('payment-cards').innerHTML, /Online collection \(verified\)[\s\S]*20\.00/);
  assert.match(element('payment-cards').innerHTML, /Cash collection \(verified\)[\s\S]*30\.00/);
  element('invoice-status').value = 'in_process';
  element('invoice-status').listeners.input();
  assert.match(element('invoice-body').innerHTML, /In process/);
  payments[0].verificationStatus = 'rejected';
  invoice.paymentStatus = 'partial';
  element('invoice-status').value = '';
  ui.setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('Add payment'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(element('invoice-body').innerHTML, /Add payment/);
});

test('payment form starts with the outstanding amount and reports a failed save', async () => {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: true, disabled: false, listeners: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} });
    return elements.get(id);
  };
  const invoice = { id: 'orderA', invoiceNumber: 'INV-SS-1', orderNumber: 'SS-1', ownerUid: 'userA', customerSnapshot: { fullName: 'Asha' }, totalPaise: 10000, verifiedPaidPaise: 2500, paymentStatus: 'partially_paid' };
  let rejectSave;
  const context = {
    document: { getElementById: element, addEventListener() {} }, uniqueId: () => 'request-1', isStaff, hasPermission, paymentInvoiceSummary, paymentUpload, showToast() {},
    listInvoices: async () => [invoice], listPayments: async () => [],
    callOperation: async (_functions, name, data) => { calls.push({ name, data }); return new Promise((_resolve, reject) => { rejectSave = reject; }); },
    FormData: class { get(name) { return { amount: '75.00', mode: 'cash', reference: '' }[name]; } },
  };
  const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'userA' }, { role: 'user', active: true, fullName: 'User A' });
  for (let i = 0; i < 10 && !element('invoice-body').innerHTML.includes('Add payment'); i++) await new Promise(resolve => setTimeout(resolve, 0));
  element('invoice-body').listeners.click({ target: { closest: () => ({ dataset: { finance: 'submit', id: 'orderA' } }) } });
  assert.match(element('finance-fields').innerHTML, /name="amount"[^>]*max="75\.00" value="75\.00"/);

  const submission = element('finance-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(element('finance-save').disabled, true);
  assert.equal(element('finance-save').textContent, 'Saving…');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'submitPayment');
  assert.equal(calls[0].data.amountPaise, 7500);
  assert.equal(calls[0].data.operationId, 'request-1');
  await element('finance-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(calls.length, 1);
  rejectSave(new Error('The live payment backend is unavailable.'));
  await submission;
  assert.match(element('finance-error').textContent, /backend is unavailable/);
  assert.equal(element('finance-error').hidden, false);
  assert.equal(element('finance-save').disabled, false);
  assert.equal(element('finance-save').textContent, 'Submit for Verification');

  element('finance-form').listeners.invalid({ target: { name: 'amount' } });
  assert.match(element('finance-error').textContent, /Enter an amount greater than zero/);
  assert.equal(element('finance-error').hidden, false);
});
