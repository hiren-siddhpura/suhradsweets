import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hasPermission, isStaff } from '../js/permissions.js';
import { cardIcon, cardButton, cardMore } from '../js/mobile-card.js';
import { sortUsersByName } from '../js/user-sort.js';

const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');

async function viewFor(role, status = 'unverified') {
  const nodes = new Map(), dialogs = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} });
    return nodes.get(id);
  };
  const payment = { id: 'paymentA', invoiceId: 'invoiceA', invoiceNumber: 'INV-1', orderNumber: 'SS-1', customerSnapshot: { fullName: 'Asha' }, amountPaise: 1000, mode: 'cash', transactionNumber: '-', submittedBy: 'userA', verificationStatus: status, submittedAt: { toDate: () => new Date('2026-10-11T10:00:00Z') } };
  const context = {
    cardIcon, cardButton, cardMore, sortUsersByName, isStaff, hasPermission,
    document: { getElementById: node, addEventListener() {}, createElement() { const dialog = { innerHTML: '', added: '', insertAdjacentHTML(_where, html) { this.added += html; }, querySelector() { return {}; }, querySelectorAll() { return []; }, showModal() {}, close() {}, remove() {} }; return dialog; }, body: { append(dialog) { dialogs.push(dialog); } } },
    listInvoices: async () => [], listPayments: async () => [payment], listMasterRecords: async () => [], listCustomers: async () => [], listOrders: async () => [], callOperation: async () => ({ payments: [] }), showToast() {},
  };
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'userA' }, { role, active: true, fullName: 'Reviewer' });
  for (let i = 0; i < 10 && !node('payment-body').innerHTML.includes('paymentA'); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  node('payment-body').listeners.click({ target: { closest: () => ({ dataset: { finance: 'paymentDetails', id: 'paymentA' } }) } });
  return { table: node('payment-body').innerHTML, dialog: dialogs[0] };
}

test('pending payment detail offers review to Admin and Account Admin', async () => {
  for (const role of ['admin', 'account_admin']) {
    const view = await viewFor(role);
    assert.match(view.dialog.added, /data-review="verify"[^>]*>Approve/);
    assert.match(view.dialog.added, /data-review="reject"[^>]*>Reject/);
  }
});

test('regular User and reviewed payments have no active detail actions', async () => {
  assert.doesNotMatch((await viewFor('user')).dialog.added, /data-review=/);
  assert.doesNotMatch((await viewFor('admin', 'verified')).dialog.added, /data-review=/);
  assert.doesNotMatch((await viewFor('admin', 'rejected')).dialog.added, /data-review=/);
});
