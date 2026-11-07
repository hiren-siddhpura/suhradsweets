import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { actionLabel, activityDate, changeSummary, references } from '../js/activity-format.js';
import { hasPermission, isStaff } from '../js/permissions.js';
import { sortUsersByName } from '../js/user-sort.js';
import { cardIcon, cardButton, cardMore } from '../js/mobile-card.js';

const source = readFileSync(new URL('../js/finance-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initFinanceUi', 'function initFinanceUi');

test('payment activity renders readable cards while preserving filters, export and table rows', async () => {
  const nodes = new Map(), documentEvents = {}, requests = [], exports = [];
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, insertAdjacentHTML(_where, html) { this.innerHTML += html; }, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, showModal() {} });
    return nodes.get(id);
  };
  const rows = [
    { id: 'one', type: 'payment.submitted', at: '2026-11-01T10:00:00Z', actorName: 'Ravirajsinh Jadeja Very Long Actor Name', customerName: 'Nikul Bhai CTM Long Customer Name', orderNumber: 'SS-2026-000192', invoiceNumber: 'INV-SS-2026-000192-EXTRA-LONG', amountPaise: 987654321, mode: 'upi', outcome: 'Success' },
    { id: 'two', type: 'payment.rejected', at: '2026-11-02T10:00:00Z', actorName: 'Accounts', customerName: 'Asha Shah', orderNumber: 'SS-2026-000193', invoiceNumber: 'INV-SS-2026-000193', amountPaise: 1000, outcome: 'Rejected' },
  ];
  const context = { cardIcon, cardButton, cardMore, sortUsersByName, listMasterRecords: async () => [], listCustomers: async () => [], listOrders: async () => [], document: { getElementById: el, addEventListener(type, fn) { documentEvents[type] = fn; } }, hasPermission, isStaff, actionLabel, activityDate, changeSummary, references, showToast() {}, listInvoices: async () => [], listPayments: async () => [], listActivity: async (_db, _profile, _uid, _kind, filters) => { requests.push(filters); return { rows, hasMore: false }; }, downloadXlsx: async (_name, sheets) => exports.push(sheets), callOperation: async () => ({ payments: [] }) };
  vm.runInNewContext(`${source}\nthis.init = initFinanceUi;`, context);
  context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin', active: true, displayName: 'Admin' });
  documentEvents['oms:pagechange']({ detail: { page: 'payments' } });
  for (let i = 0; i < 10 && !el('payment-activity-cards').innerHTML.includes('Ravirajsinh'); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const cards = el('payment-activity-cards').innerHTML;
  assert.equal((cards.match(/class="payment-activity-card"/g) || []).length, 2);
  for (const value of ['Payment submitted', 'Ravirajsinh Jadeja Very Long Actor Name', 'Nikul Bhai CTM Long Customer Name', 'SS-2026-000192', 'INV-SS-2026-000192-EXTRA-LONG', '₹98,76,543.21']) assert.ok(cards.includes(value), value);
  assert.match(cards, /payment-activity-outcome">Rejected/);
  assert.match(cards, /payment-activity-outcome">Success/);
  assert.equal((el('payment-activity-body').innerHTML.match(/<tr>/g) || []).length, 2);
  el('payment-activity-customer').value = 'Nikul';
  el('payment-activity-apply').onclick();
  for (let i = 0; i < 10 && requests.at(-1)?.customer !== 'Nikul'; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.at(-1).customer, 'Nikul');
  await el('payment-activity-export').onclick();
  assert.equal(exports[0][0][1].length, 2);
});

