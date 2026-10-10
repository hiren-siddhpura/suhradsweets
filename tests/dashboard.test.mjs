import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { quantityInKg, summarizeOrderKg, targetPercentage, validateTargetKg } from '../js/dashboard-metrics.js';

test('a missing dashboard index preserves other cards without a visible warning or link', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, children: [], addEventListener() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    return elements.get(id);
  };
  const missingIndex = Object.assign(new Error('The query requires an index. https://console.firebase.google.com/v1/r/project/example/firestore/indexes?create_composite=example'), { code: 'failed-precondition' });
  const context = {
    document: { getElementById: element, querySelector: () => null, addEventListener() {}, createElement: () => ({}) },
    isStaff: (profile) => profile?.role === 'admin', showToast() {}, callOperation() {}, downloadXlsx() {},
    reportUsers: async () => [], targetPercentage,
    dashboardOrderKg: async () => ({ orderCount: 7, totalKg: 10, items: [{ name: 'Sweet', kg: 10 }], excludedQuantities: 0 }),
    dashboardTargetKg: async () => 20,
    dashboardStockKg: async () => { throw missingIndex; },
    recentActivity: async () => [], activeAnnouncements: async () => { throw missingIndex; },
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
