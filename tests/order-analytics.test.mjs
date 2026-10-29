import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { analyticsColumns, analyticsCsv, lineQuantity, matchingOrders, quantities, quantityText, sortAnalyticsRows, statusSortValue, totalText } from '../js/order-analytics-data.js';
import { getOrderAnalytics } from '../functions/order-analytics.js';

const source = {
  items: [{ id: 'kaju', name: 'Kaju Katri', unitSymbol: 'KG' }, { id: 'packing', name: 'Gift Packing', unitSymbol: 'PCS' }],
  users: [{ id: 'a', name: 'Abhishek' }, { id: 'b', name: 'Rahul' }],
  orders: [
    { id: 'one', ownerUid: 'a', assignedUserId: 'a', customerName: 'Ajay', orderDate: '2026-10-10', status: 'confirmed', orderNumber: 'SS-1', lines: [{ productId: 'kaju', quantityQty: 2000, orderUnitId: '500gm' }, { productId: 'packing', quantityQty: 3000, orderUnitId: 'pcs' }] },
    { id: 'two', ownerUid: 'b', assignedUserId: 'b', customerName: 'Vikas', orderDate: '2026-10-11', status: 'ready', orderNumber: 'SS-2', lines: [{ productId: 'kaju', quantityQty: 1000, orderUnitId: 'kg' }] },
  ],
};

test('weight and pieces remain separate; summary and detail totals use the same quantities', () => {
  assert.deepEqual(lineQuantity({ quantityQty: 2000, orderUnitId: 'legacy-half', orderUnitName: '500 GM' }), { unit: 'KG', value: 1 });
  assert.deepEqual(lineQuantity({ quantityQty: 3000, orderUnitId: 'pcs' }), { unit: 'PCS', value: 3 });
  assert.deepEqual(lineQuantity({ quantityQty: 1000, orderUnitId: '250gm' }), { unit: 'KG', value: .25 });
  const columns = analyticsColumns(source);
  const all = quantities(source.orders, columns), own = quantities([source.orders[0]], columns);
  assert.equal(all['kaju:KG'], 2);
  assert.equal(own['kaju:KG'], 1);
  assert.equal(all['packing:PCS'], 3);
  assert.equal(totalText(all, columns), '2 KG + 3 PCS');
  assert.equal(quantityText(all['kaju:KG'], 'KG'), '2 KG');
});

test('search, date, status and user filters select one order before aggregation', () => {
  assert.deepEqual(matchingOrders(source, { user: 'a', from: '2026-10-10', to: '2026-10-10', status: 'confirmed', search: 'Ajay' }).map((order) => order.id), ['one']);
  assert.deepEqual(matchingOrders(source, { user: 'b', status: 'confirmed' }), []);
  assert.deepEqual(matchingOrders(source, { search: 'Rahul' }).map((order) => order.id), ['two']);
});

test('analytics filters use assigned user when order owner differs', () => {
  const reassigned = { ...source.orders[0], id: 'reassigned', assignedUserId: 'b' };
  const data = { ...source, orders: [reassigned] };
  assert.deepEqual(matchingOrders(data, { user: 'b' }).map((order) => order.id), ['reassigned']);
  assert.deepEqual(matchingOrders(data, { user: 'a' }), []);
  assert.deepEqual(matchingOrders(data, { search: 'Rahul' }).map((order) => order.id), ['reassigned']);
});

test('CSV contains the same filtered quantity and total and neutralizes formulas', () => {
  const filtered = matchingOrders(source, { user: 'a' });
  const cols = analyticsColumns(source), totals = quantities(filtered, cols);
  const csv = analyticsCsv(['User', ...cols.map((col) => col.name), 'Total'], [['=Abhishek', ...cols.map((col) => quantityText(totals[col.key], col.unit)), totalText(totals, cols)]], ['Total', ...cols.map((col) => quantityText(totals[col.key], col.unit)), totalText(totals, cols)]);
  assert.match(csv, /"'=Abhishek"/);
  assert.match(csv, /"1 KG"/);
  assert.match(csv, /"3 PCS"/);
  assert.doesNotMatch(csv, /"2 KG"/);
});

test('analytics sorting compares names, decimal quantities, mixed totals, natural order numbers, dates and status ranks', () => {
  const rows = [
    { id: 'a', sortValues: { user: 'Zara', customer: 'Zara', phone: '9', area: 'South', orderNumber: 'SS-10', orderDate: '2026-10-12', 'product:kaju:KG': 1.25, total: [1.25, 2], status: statusSortValue('ready', 'Ready') } },
    { id: 'b', sortValues: { user: 'Ajay', customer: 'Ajay', phone: '10', area: 'East', orderNumber: 'SS-2', orderDate: '2026-10-02', 'product:kaju:KG': 0.5, total: [0.5, 99], status: statusSortValue('confirmed', 'Confirmed · Invoiced · Paid') } },
    { id: 'c', sortValues: { user: 'Mira', customer: 'Mira', phone: '2', area: 'North', orderNumber: 'SS-3', orderDate: '2026-10-11', 'product:kaju:KG': 1.25, total: [1.25, 3], status: statusSortValue('confirmed', 'Confirmed · Invoiced · Unpaid') } },
  ];
  const ids = (key, direction) => sortAnalyticsRows(rows, { key, direction }).map((row) => row.id);
  assert.deepEqual(ids('user', 'asc'), ['b', 'c', 'a']);
  assert.deepEqual(ids('user', 'desc'), ['a', 'c', 'b']);
  assert.deepEqual(ids('product:kaju:KG', 'asc'), ['b', 'a', 'c']);
  assert.deepEqual(ids('product:kaju:KG', 'desc'), ['a', 'c', 'b']);
  assert.deepEqual(ids('total', 'asc'), ['b', 'a', 'c']);
  assert.deepEqual(ids('total', 'desc'), ['c', 'a', 'b']);
  assert.deepEqual(ids('phone', 'asc'), ['c', 'a', 'b']);
  assert.deepEqual(ids('area', 'asc'), ['b', 'c', 'a']);
  assert.deepEqual(ids('orderNumber', 'asc'), ['b', 'c', 'a']);
  assert.deepEqual(ids('orderDate', 'asc'), ['b', 'c', 'a']);
  assert.deepEqual(ids('status', 'asc'), ['c', 'b', 'a']);
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
});

function database() {
  const records = {
    users: [{ id: 'a', role: 'user', active: true, fullName: 'Abhishek' }, { id: 'b', role: 'user', active: true, fullName: 'Rahul' }, { id: 'admin', role: 'admin', active: true, fullName: 'Owner' }, { id: 'account', role: 'account_admin', active: true, fullName: 'Accounts' }],
    orders: [{ id: 'one', ownerUid: 'a', assignedUserId: 'a', customerId: 'ca', customerSnapshot: { fullName: 'Ajay' }, status: 'confirmed', lines: [] }, { id: 'two', ownerUid: 'b', assignedUserId: 'b', customerId: 'cb', customerSnapshot: { fullName: 'Vikas' }, status: 'ready', lines: [] }, { id: 'linked', ownerUid: 'a', assignedUserId: 'a', customerId: 'cl', customerSnapshot: { fullName: 'Linked' }, status: 'confirmed', lines: [] }, { id: 'cancel', ownerUid: 'a', assignedUserId: 'a', status: 'cancelled', lines: [] }, { id: 'reassigned', ownerUid: 'b', assignedUserId: 'a', customerId: 'cb', customerSnapshot: { fullName: 'Vikas' }, status: 'confirmed', lines: [] }],
    customers: [{ id: 'ca', assignedUserId: 'a', fullName: 'Ajay', contact: '111', area: 'North' }, { id: 'cb', assignedUserId: 'b', fullName: 'Vikas', contact: '222', area: 'South' }, { id: 'cl', assignedUserId: 'b', ownerUserIds: ['a'], fullName: 'Linked', contact: '333', area: 'East' }],
    invoices: [{ id: 'invoice-a', ownerUid: 'a', orderId: 'one', paymentStatus: 'unpaid' }, { id: 'invoice-b', ownerUid: 'b', orderId: 'two', paymentStatus: 'paid' }, { id: 'invoice-r', ownerUid: 'b', orderId: 'reassigned', paymentStatus: 'paid' }], payments: [{ id: 'payment-a', ownerUid: 'a', orderId: 'one', verificationStatus: 'unverified' }, { id: 'payment-b', ownerUid: 'b', orderId: 'two', verificationStatus: 'verified' }],
    items: [{ id: 'kaju', active: true, name: 'Kaju Katri', defaultUnitId: 'kg' }], units: [{ id: 'kg', symbol: 'KG' }],
  };
  const snap = (row) => ({ id: row.id, exists: true, data: () => row });
  return {
    doc(path) { const [kind, id] = path.split('/'); return { async get() { const row = records[kind]?.find((entry) => entry.id === id); return row ? snap(row) : { exists: false }; } }; },
    collection(kind) { const query = (field, value) => ({ async get() { return { docs: records[kind].filter((row) => row[field] === value).map(snap) }; } }); return { where(field, op, value) { assert.equal(op, '=='); return query(field, value); }, async get() { return { docs: records[kind].map(snap) }; } }; },
    async getAll(...refs) { return Promise.all(refs.map((ref) => ref.get())); },
  };
}

test('trusted callable scopes users, orders, customers and invoices to authenticated UID', async () => {
  const db = database();
  const own = await getOrderAnalytics(db, 'a', { userId: 'b' });
  assert.deepEqual(own.users.map((row) => row.id), ['a']);
  assert.deepEqual(own.orders.map((row) => row.id), ['one', 'linked', 'reassigned']);
  assert.deepEqual(own.customers.map((row) => row.id), ['ca', 'cl', 'cb']);
  assert.deepEqual(own.invoices.map((row) => row.orderId), ['one', 'reassigned']);
  assert.deepEqual(own.payments.map((row) => row.orderId), ['one']);
  const other = await getOrderAnalytics(db, 'b');
  assert.deepEqual(other.orders.map((row) => row.id), ['two']);
  for (const uid of ['admin', 'account']) {
    const staff = await getOrderAnalytics(db, uid);
    assert.deepEqual(staff.orders.map((row) => row.id), ['one', 'two', 'linked', 'reassigned']);
    assert.equal(staff.users.length, 4);
  }
});

test('analytics navigation and responsive table use authorized callable and CSV output', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../js/order-analytics-ui.js', import.meta.url), 'utf8');
  assert.match(html, /data-page="orderAnalytics"/);
  assert.match(css, /\.order-analytics-scroll\{[^}]*overflow:auto/);
  assert.match(css, /\.order-analytics-table th:first-child,\.order-analytics-table td:first-child\{position:sticky/);
  assert.match(ui, /callOperation\(functions, 'getOrderAnalytics', \{\}\)/);
  assert.match(ui, /text\/csv;charset=utf-8/);
});

test('Order Analytics navigation opens the real table view and hides the placeholder', () => {
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { hidden: true, dataset: {}, listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, append() {}, setAttribute() {}, removeAttribute() {}, addEventListener(type, listener) { this.listeners[type] = listener; } }); return nodes.get(id); };
  const button = node('analytics-nav'); button.dataset.page = 'orderAnalytics'; button.hidden = false;
  const document = { getElementById: node, querySelectorAll(selector) { return selector === '[data-page]' ? [button] : []; }, querySelector() { return null; }, dispatchEvent() {} };
  const window = { addEventListener() {}, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} } };
  const source = readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export function ', 'function ');
  const context = { document, window, PAGES: { orderAnalytics: { title: 'Order Analytics', description: 'Item quantities' } }, CustomEvent: class {} };
  vm.runInNewContext(`${source}\nthis.initUi = initUi;`, context);
  context.initUi();
  button.listeners.click();
  assert.equal(node('orderAnalytics-view').hidden, false);
  assert.equal(node('feature-view').hidden, true);
  assert.equal(node('topbar-page-title').textContent, 'Order Analytics');
});

test('analytics loader, filters, detail Back, CSV, error, retry and empty states', async () => {
  const nodes = new Map(), queue = [], listeners = {};
  let exportedBlob;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, disabled: false, innerHTML: '', textContent: '', scrollLeft: 0, scrollTop: 0, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
    return nodes.get(id);
  };
  const nav = { hidden: false, classList: { contains: () => false }, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
  const document = { getElementById: node, querySelector: () => nav, createElement: () => ({ click() {} }) };
  const window = { location: { href: 'https://example.test/' }, addEventListener(type, callback) { listeners[type] = callback; } };
  const previous = [];
  const history = { state: null, pushState(state) { previous.push(this.state); this.state = state; }, back() { this.state = previous.pop(); listeners.popstate({ state: this.state }); } };
  const actual = { ...source, viewerUid: 'admin', staff: true, customers: [{ id: 'ca', name: 'Ajay', phone: '123', area: 'West' }], invoices: [], payments: [] };
  actual.orders = source.orders.map((order) => ({ ...order, customerId: order.ownerUid === 'a' ? 'ca' : 'cb' }));
  const js = readFileSync(new URL('../js/order-analytics-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderAnalytics', 'function initOrderAnalytics');
  const context = { document, window, history, Blob, URL: { createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} }, setTimeout, clearTimeout, requestAnimationFrame(callback) { callback(); }, console,
    callOperation: () => queue.shift()(), analyticsColumns, analyticsCsv, matchingOrders, quantities, quantityText, sortAnalyticsRows, statusSortValue, totalText };
  vm.runInNewContext(`${js}\nthis.initOrderAnalytics = initOrderAnalytics;`, context);
  const ui = context.initOrderAnalytics({ functions: {} });
  ui.setSession({ uid: 'admin' }, { active: true, role: 'admin' });
  let resolveInitial;
  queue.push(() => new Promise((resolve) => { resolveInitial = resolve; }));
  nav.listeners.click();
  assert.equal(node('analytics-loading').hidden, false);
  assert.equal(node('analytics-table-wrap').hidden, true);
  assert.equal(node('analytics-export').disabled, true);
  resolveInitial(actual);
  await new Promise(setImmediate);
  assert.equal(node('analytics-loading').hidden, true);
  assert.equal(node('analytics-table-wrap').hidden, false);
  assert.match(node('analytics-body').innerHTML, /Abhishek/);
  const footerBeforeSort = node('analytics-foot').innerHTML;
  const clickSort = (key) => node('analytics-head').listeners.click({ target: { closest: () => ({ dataset: { sortKey: key } }) } });
  assert.ok(node('analytics-body').innerHTML.indexOf('Abhishek') < node('analytics-body').innerHTML.indexOf('Rahul'));
  clickSort('user');
  assert.ok(node('analytics-body').innerHTML.indexOf('Rahul') < node('analytics-body').innerHTML.indexOf('Abhishek'));
  assert.match(node('analytics-head').innerHTML, /aria-sort="descending"/);
  clickSort('user');
  assert.ok(node('analytics-body').innerHTML.indexOf('Abhishek') < node('analytics-body').innerHTML.indexOf('Rahul'));
  clickSort('product:packing:PCS');
  assert.ok(node('analytics-body').innerHTML.indexOf('Rahul') < node('analytics-body').innerHTML.indexOf('Abhishek'));
  assert.equal(node('analytics-foot').innerHTML, footerBeforeSort);
  node('analytics-search').value = 'Ajay';
  node('analytics-search').listeners.input();
  assert.equal(node('analytics-loading').hidden, false);
  assert.equal(node('analytics-table-wrap').hidden, true);
  await new Promise((resolve) => setTimeout(resolve, 210));
  assert.match(node('analytics-body').innerHTML, /Abhishek/);
  assert.doesNotMatch(node('analytics-body').innerHTML, /Rahul/);
  assert.match(node('analytics-foot').innerHTML, /1 KG/);
  assert.match(node('analytics-head').innerHTML, /product:packing:PCS/);
  node('analytics-export').listeners.click();
  assert.match(await exportedBlob.text(), /"1 KG"/);
  actual.orders.push({ ...actual.orders[0], id: 'third', orderNumber: 'SS-10', orderDate: '2026-10-05', status: 'ready', lines: [{ productId: 'kaju', quantityQty: 1000, orderUnitId: '250gm' }] });
  node('analytics-table-wrap').scrollLeft = 75;
  node('analytics-body').listeners.click({ target: { closest: () => ({ dataset: { analyticsUser: 'a' } }) } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(node('analytics-detail-header').hidden, false);
  assert.equal(node('analytics-detail-name').textContent, 'Abhishek');
  assert.match(node('analytics-body').innerHTML, /Ajay/);
  assert.match(node('analytics-body').innerHTML, /123/);
  const detailFooter = node('analytics-foot').innerHTML;
  const detailOrder = () => [...node('analytics-body').innerHTML.matchAll(/data-analytics-row="([^"]+)"/g)].map((match) => match[1]);
  clickSort('orderNumber'); clickSort('orderNumber');
  assert.deepEqual(detailOrder(), ['third', 'one']);
  clickSort('orderDate');
  assert.deepEqual(detailOrder(), ['third', 'one']);
  clickSort('product:kaju:KG');
  assert.deepEqual(detailOrder(), ['third', 'one']);
  clickSort('status');
  assert.deepEqual(detailOrder(), ['one', 'third']);
  assert.equal(node('analytics-foot').innerHTML, detailFooter);
  node('analytics-back').listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(node('analytics-detail-header').hidden, true);
  assert.equal(node('analytics-search').value, 'Ajay');
  assert.equal(node('analytics-table-wrap').scrollLeft, 75);
  queue.push(() => Promise.reject(Object.assign(new Error('network'), { code: 'unavailable' })));
  await node('analytics-refresh').listeners.click();
  assert.equal(node('analytics-loading').hidden, true);
  assert.equal(node('analytics-error').hidden, false);
  assert.equal(node('analytics-table-wrap').hidden, true);
  queue.push(() => Promise.resolve({ ...actual, orders: [] }));
  await node('analytics-retry').listeners.click();
  assert.equal(node('analytics-error').hidden, true);
  assert.equal(node('analytics-loading').hidden, true);
  assert.match(node('analytics-body').innerHTML, /No orders match these filters/);
  ui.setSession({ uid: 'a' }, { active: true, role: 'user' });
  queue.push(() => Promise.resolve({ ...actual, viewerUid: 'a', staff: false }));
  nav.listeners.click();
  await new Promise(setImmediate);
  assert.equal(node('analytics-user-wrap').hidden, true);
  assert.match(node('analytics-body').innerHTML, /Abhishek/);
  assert.doesNotMatch(node('analytics-body').innerHTML, /Rahul/);
  node('analytics-body').listeners.click({ target: { closest: () => ({ dataset: { analyticsUser: 'b' } }) } });
  assert.equal(node('analytics-detail-header').hidden, true);
});

test('analytics stops loading after a slow request times out and blocks duplicate fetches', async () => {
  const nodes = new Map(); let calls = 0;
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, disabled: false, innerHTML: '', textContent: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } }); return nodes.get(id); };
  const nav = { hidden: false, classList: { contains: () => false }, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  const document = { getElementById: node, querySelector: () => nav };
  const window = { location: { href: 'https://example.test/' }, addEventListener() {} };
  const js = readFileSync(new URL('../js/order-analytics-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderAnalytics', 'function initOrderAnalytics');
  const context = { document, window, history: { state: null }, setTimeout: (callback, delay) => setTimeout(callback, delay >= 20000 ? 20 : delay), clearTimeout, console, callOperation: () => { calls++; return new Promise(() => {}); }, analyticsColumns, analyticsCsv, matchingOrders, quantities, quantityText, sortAnalyticsRows, statusSortValue, totalText };
  vm.runInNewContext(`${js}\nthis.initOrderAnalytics = initOrderAnalytics;`, context);
  context.initOrderAnalytics({ functions: {} }).setSession({ uid: 'a' }, { active: true, role: 'user' });
  nav.listeners.click();
  node('analytics-refresh').listeners.click();
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(node('analytics-loading').hidden, true);
  assert.equal(node('analytics-error').hidden, false);
  assert.match(node('analytics-error-text').textContent, /taking too long/);
});
