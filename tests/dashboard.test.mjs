import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { quantityInKg, summarizeOrderKg, targetPercentage, validateTargetKg } from '../js/dashboard-metrics.js';
import { hasPermission } from '../js/permissions.js';

test('report lists show the OMS loader instead of a loading records message', async () => {
  const nodes = new Map(), listeners = {}, active = new Set();
  let resolvePage;
  const el = id => { if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, hidden: false, addEventListener() {} }); return nodes.get(id); };
  const context = {
    document: { getElementById: el, querySelector: () => null, addEventListener(type, fn) { listeners[type] = fn; } },
    isStaff: profile => profile?.role === 'admin', hasPermission, reportUsers: async () => [],
    reportPage: () => new Promise(resolve => { resolvePage = resolve; }),
    omsLoading: { start() { const token = Symbol(); active.add(token); return token; }, stop(token) { active.delete(token); } },
    showToast() {},
  };
  const source = readFileSync(new URL('../js/reporting-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initReportingUi', 'function initReportingUi');
  vm.runInNewContext(`${source}\nthis.init = initReportingUi;`, context);
  await context.init({ db: {}, functions: {} }).setSession({ uid: 'admin' }, { role: 'admin', active: true });
  listeners['oms:pagechange']({ detail: { page: 'loginLogs' } });
  assert.equal(active.size, 1);
  assert.equal(el('login-message').textContent, '');
  resolvePage({ rows: [], hasMore: false, cursor: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active.size, 0);
  assert.match(el('login-body').innerHTML, /No login events/);
});

test('a missing dashboard index preserves other cards without a visible warning or link', async () => {
  const elements = new Map();
  let targetReads = 0, stockReads = 0, activityReads = 0, announcementReads = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, children: [], addEventListener() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    return elements.get(id);
  };
  const missingIndex = Object.assign(new Error('The query requires an index. https://console.firebase.google.com/v1/r/project/example/firestore/indexes?create_composite=example'), { code: 'failed-precondition' });
  const context = {
    document: { getElementById: element, querySelector: () => null, addEventListener() {}, createElement: () => ({}) },
    isStaff: (profile) => profile?.role === 'admin', hasPermission, showToast() {}, callOperation() {}, downloadXlsx() {},
    reportUsers: async () => [], targetPercentage,
    dashboardOrderKg: async () => ({ orderCount: 7, totalKg: 10, items: [{ name: 'Sweet', kg: 10 }], excludedQuantities: 0 }),
    dashboardTargetKg: async () => { targetReads++; return 20; },
    dashboardStockKg: async () => { stockReads++; throw missingIndex; },
    listInvoices: async () => [{ paymentStatus: 'unpaid' }, { paymentStatus: 'paid' }],
    recentActivity: async () => { activityReads++; return []; }, activeAnnouncements: async () => { announcementReads++; throw missingIndex; },
    currentTargets: async () => [], targetAchievement: async () => 0,
    console: { warn() {} }, Intl, Date, Set, Object, Promise, Number, String,
  };
  const source = readFileSync(new URL('../js/reporting-ui.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function initReportingUi', 'function initReportingUi');
  vm.runInNewContext(`${source}\nthis.initialize = initReportingUi;`, context);
  const ui = context.initialize({ db: {}, functions: {} });
  await ui.setSession({ uid: 'test-admin' }, { role: 'admin', fullName: 'Test Admin' });
  await element('dashboard-refresh').onclick();
  assert.match(element('dashboard-cards').innerHTML, /Total Orders/);
  assert.match(element('dashboard-cards').innerHTML, /<strong>7 /);
  assert.match(element('dashboard-cards').innerHTML, /50\.0 %/);
  assert.match(element('dashboard-cards').innerHTML, /Sweet/);
  assert.equal((element('dashboard-cards').innerHTML.match(/class="card stat-card/g) || []).length, 4);
  assert.match(element('dashboard-cards').innerHTML, /Unavailable/);
  assert.match(element('dashboard-activity').innerHTML, /No recent activity/);
  assert.equal(elements.has('dashboard-message'), false);
  assert.equal(elements.has('dashboard-index-links'), false);
  assert.equal(elements.has('dashboard-from'), false);
  assert.equal(elements.has('dashboard-to'), false);
  await ui.setSession({ uid: 'test-user' }, { role: 'user', active: true, fullName: 'Test User' });
  const priorReads = [targetReads, stockReads, activityReads, announcementReads];
  await element('dashboard-refresh').onclick();
  assert.match(element('dashboard-cards').innerHTML, /Total Orders[\s\S]*7/);
  assert.doesNotMatch(element('dashboard-cards').innerHTML, /Target Achievement|Available Stock|Total Selling|KG/);
  assert.equal((element('dashboard-cards').innerHTML.match(/class="card stat-card/g) || []).length, 1);
  assert.equal(element('dashboard-activity-panel').hidden, true);
  assert.equal(element('dashboard-announcements-panel').hidden, true);
  assert.deepEqual([targetReads, stockReads, activityReads, announcementReads], [priorReads[0], priorReads[1], priorReads[2], priorReads[3]]);
  assert.equal(elements.has('dashboard-priority'), false);
});

test('KG conversion excludes count units and sales snapshots count combos once', () => {
  assert.equal(quantityInKg(2500, 'KG'), 2.5);
  assert.equal(quantityInKg(500000, 'g'), 0.5);
  assert.equal(quantityInKg(1000, 'box'), null);
  const snapshot = { name: 'Sweet', unitSymbol: 'kg' };
  const result = summarizeOrderKg([
    { status: 'confirmed', stockDeductions: [{ itemId: 'sweet', quantityQty: 2000, itemSnapshot: snapshot }], lines: [{ kind: 'item', productId: 'sweet', quantityQty: 2000, itemSnapshot: snapshot }] },
    { status: 'delivered', lines: [{ kind: 'special', quantityQty: 2000, specialSnapshot: { components: [{ itemId: 'sweet', quantityQty: 500, itemSnapshot: snapshot }] } }] },
    { status: 'cancelled', stockDeductions: [{ itemId: 'sweet', quantityQty: 5000, itemSnapshot: snapshot }] },
    { status: 'draft', lines: [{ kind: 'item', quantityQty: 9000, itemSnapshot: snapshot }] },
  ]);
  assert.equal(result.orderCount, 3);
  assert.equal(result.totalKg, 3);
  assert.equal(result.items[0].kg, 3);
  assert.equal(targetPercentage(3, 6), 50);
  assert.equal(targetPercentage(3, 0), null);
  assert.equal(validateTargetKg('12.345'), '12.345');
  assert.throws(() => validateTargetKg('-1'));
  assert.throws(() => validateTargetKg('12.3456'));
});

test('Regular User order count matches assigned orders across statuses and owners', async () => {
  const source = readFileSync(new URL('../js/reporting-data.js', import.meta.url), 'utf8')
    .split('export async function dashboardTargetKg')[0]
    .replace(/^import .*;\r?\n/gm, '').replace('export async function dashboardOrderKg', 'async function dashboardOrderKg');
  const records = [
    { id: 'a', assignedUserId: 'u1', status: 'confirmed', orderDate: '2026-10-30' },
    { id: 'b', assignedUserId: 'u1', status: 'invoiced', orderDate: '2026-10-31' },
    { id: 'c', assignedUserId: 'u1', status: 'paid', orderDate: '2026-10-31' },
    { id: 'd', assignedUserId: 'u1', status: 'cancelled' },
    { id: 'e', assignedUserId: 'u2', status: 'confirmed', orderDate: '2026-10-31' },
  ];
  const context = {
    summarizeOrderKg, collection: () => ({}), where: (field, op, value) => ({ field, op, value }),
    query: (_, ...terms) => terms, getDocs: async (terms) => ({ docs: records.filter((record) => terms.every((term) => {
      const value = record[term.field];
      return value !== undefined && (term.op === '==' ? value === term.value : term.op === '>=' ? value >= term.value : value <= term.value);
    })).map(({ id, ...data }) => ({ id, data: () => data })) }),
  };
  vm.runInNewContext(`${source}\nthis.dashboardOrderKg = dashboardOrderKg;`, context);
  const count = async (uid, from, to) => (await context.dashboardOrderKg({}, 'user', uid, from, to)).orderCount;
  assert.equal(await count('nobody'), 0);
  assert.equal(await count('u2'), 1);
  assert.equal(await count('u1'), 4);
  assert.equal(await count('u1', '2026-10-30', '2026-10-30'), 1);
  assert.equal(await count('u1', '2026-10-31', '2026-10-31'), 2);
  records.push({ id: 'f', assignedUserId: 'u1', status: 'confirmed', orderDate: '2026-10-31' });
  assert.equal(await count('u1'), 5, 'a new order is counted on the next dashboard read');
});

test('Admin and Account Admin retain the existing paginated sales count', async () => {
  const source = readFileSync(new URL('../js/reporting-data.js', import.meta.url), 'utf8')
    .split('export async function dashboardTargetKg')[0]
    .replace(/^import .*;\r?\n/gm, '').replace('export async function dashboardOrderKg', 'async function dashboardOrderKg');
  const records = Array.from({ length: 101 }, (_, index) => ({ id: String(index), status: index === 100 ? 'cancelled' : 'confirmed', orderDate: '2026-10-31' }));
  const context = {
    summarizeOrderKg, collection: () => ({}), where: () => ({}), orderBy: () => ({}),
    startAfter: (cursor) => ({ cursor }), limit: (size) => ({ size }), query: (_, ...terms) => terms,
    getDocs: async (terms) => {
      const cursor = terms.find((term) => term.cursor)?.cursor;
      const start = cursor ? Number(cursor.id) + 1 : 0;
      return { docs: records.slice(start, start + 100).map(({ id, ...data }) => ({ id, data: () => data })) };
    },
  };
  vm.runInNewContext(`${source}\nthis.dashboardOrderKg = dashboardOrderKg;`, context);
  assert.equal((await context.dashboardOrderKg({}, 'admin', 'admin')).orderCount, 100);
  assert.equal((await context.dashboardOrderKg({}, 'account_admin', 'account-admin')).orderCount, 100);
});
