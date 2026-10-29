import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isStaff } from '../js/permissions.js';
import { BOX_UNITS } from '../js/box-req-calc.js';
const source = readFileSync(new URL('../js/box-req-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initBoxReq', 'function initBoxReq');
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
function setup(read) {
  const ids = new Map(), events = {}, active = new Set(); let reads = 0;
  const el = (id) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const context = { document: { getElementById: el, createElement: (tag) => new Element(tag), addEventListener: (name, callback) => { events[name] = callback; } }, isStaff, BOX_UNITS, listBoxRequirements: async () => { reads++; return read(); }, omsLoading: { start() { const token = Symbol(); active.add(token); return token; }, stop(token) { active.delete(token); } } };
  vm.runInNewContext(`${source}\nthis.init = initBoxReq;`, context);
  context.init({ db: {} }).setSession({ uid: 'admin' }, { role: 'admin', active: true });
  return { el, events, active, get reads() { return reads; } };
}
const data = { items: [{ id: 'kaju', name: 'Kaju Katri', quantities: { '250gm': 10, '500gm': 60, kg: 5 } }], totals: { '250gm': 10, '500gm': 60, kg: 5 }, orderCount: 1 };
test('Box Req. renders special and wrapping table cells without a footer', async () => {
  const app = setup(() => ({ ...data,
    specials: [{ name: 'Kaju Katri + Anjir Cake 500g', quantity: 40, unit: 'PCS' }],
    wrapping: [{ name: 'Kaju Katri', quantity: 28, unit: '250 GM' }, { name: 'Anjir Roll', quantity: 3, unit: 'PCS' }],
    wrappingTotals: { '250 GM': 28, PCS: 3 },
  }));
  app.events['oms:pagechange']({ detail: { page: 'boxReq' } }); await tick();
  assert.equal(app.el('boxReq-specials').children[0].tag, 'tr');
  assert.deepEqual(app.el('boxReq-specials').children[0].children.map((cell) => cell.textContent), ['Kaju Katri + Anjir Cake 500g', '40 PCS']);
  assert.deepEqual(app.el('boxReq-wrapping').children[0].children.map((cell) => cell.textContent), ['Kaju Katri', '28', '250 GM']);
  assert.equal(app.el('boxReq-wrapping').children.length, 2);
});
test('Box Req. renders read-only table, summary and search', async () => {
  const app = setup(() => data);
  app.events['oms:pagechange']({ detail: { page: 'boxReq' } }); await tick();
  assert.equal(app.active.size, 0);
  assert.deepEqual(app.el('boxReq-body').children[0].children.map((cell) => cell.textContent), ['Kaju Katri', '10', '60', '5']);
  assert.equal(app.el('boxReq-summary').children[0].children[1].textContent, '10');
  app.el('boxReq-search').value = 'none'; app.el('boxReq-search').listeners.input();
  assert.match(app.el('boxReq-body').children[0].children[0].textContent, /No sweets match/);
  assert.equal(app.reads, 1);
});
test('Box Req. loader stops on empty, failure, refresh, and navigation', async () => {
  const empty = setup(() => ({ items: [], totals: { '250gm': 0, '500gm': 0, kg: 0 }, orderCount: 0 }));
  empty.events['oms:pagechange']({ detail: { page: 'boxReq' } }); await tick();
  assert.equal(empty.active.size, 0);
  assert.match(empty.el('boxReq-body').children[0].children[0].textContent, /No boxes required/);
  assert.match(empty.el('boxReq-specials').children[0].children[0].textContent, /No special items/);
  assert.match(empty.el('boxReq-wrapping').children[0].children[0].textContent, /No gift wrapping/);
  empty.el('boxReq-refresh').listeners.click(); await tick(); assert.equal(empty.active.size, 0);
  const failed = setup(() => { throw new Error('offline'); });
  failed.events['oms:pagechange']({ detail: { page: 'boxReq' } }); await tick();
  assert.equal(failed.active.size, 0); assert.match(failed.el('boxReq-message').textContent, /offline/);
  assert.equal(failed.el('boxReq-body').children.length, 0);
});
