import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from '../js/order-units.js';
import { hasPermission, isStaff, validateProfile } from '../js/permissions.js';
import { validateCustomerInput } from '../js/customer-validation.js';

test('Orders page contains the controls required by order initialization', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['orders-view', 'order-new', 'order-refresh', 'order-intake', 'order-search', 'order-status', 'order-archive', 'order-user', 'order-from', 'order-to', 'order-export', 'order-cards', 'order-loading', 'order-message', 'order-body', 'order-activity-actor', 'order-activity-customer', 'order-activity-order', 'order-activity-type', 'order-activity-from', 'order-activity-to', 'order-activity-apply', 'order-activity-export', 'order-activity-message', 'order-activity-body', 'order-activity-prev', 'order-activity-page', 'order-activity-next']) {
    assert.match(html, new RegExp(`id="${id}"`), `Missing ${id}`);
  }
});

test('searchable customer choice preserves order form through customer cancel and creation', async () => {
  const nodes = new Map(), saved = [], orderSaves = [], toasts = []; let stockReads = 0;
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll() { return []; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const fields = el('order-fields');
  const dialogClasses = new Set();
  const dialogStyles = new Map();
  el('order-dialog').classList = { toggle(name, force) { if (force) dialogClasses.add(name); else dialogClasses.delete(name); }, contains(name) { return dialogClasses.has(name); }, remove(name) { dialogClasses.delete(name); } };
  el('order-dialog').style = { setProperty(name, value) { dialogStyles.set(name, value); }, removeProperty(name) { dialogStyles.delete(name); } };
  el('order-dialog').contains = () => true;
  const visualViewport = { height: 844, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, removeEventListener(name) { delete this.listeners[name]; } };
  let markup = '', formNodes = [];
  Object.defineProperties(fields, {
    innerHTML: { get() { return markup; }, set(value) { markup = value; formNodes = value.includes('id="order-lines"') ? [{ note: 'keep my order note', parent: fields }] : value ? [{ customer: true, parent: fields }] : []; } },
    firstChild: { get() { return formNodes[0] || null; } },
    children: { get() { return formNodes; } },
  });
  fields.appendChild = (node) => { if (node.children) { for (const child of node.children.splice(0)) { child.parent = fields; formNodes.push(child); } } else { node.parent = fields; formNodes.push(node); } };
  const current = () => formNodes[0];
  const values = { fullName: 'New Customer', contact: '9876543210', address: 'Road', area: 'West', dateOfBirth: '', sabha: 'false' };
  const context = {
    document: { getElementById: el, addEventListener() {}, querySelector() { return null; }, createDocumentFragment() { return { children: [], appendChild(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); } }; } },
    uniqueId: () => 'customer-request-1', FormData: class { get(name) { return values[name]; } },
    isStaff, validateProfile, hasPermission, validateCustomerInput, showToast(message) { toasts.push(message); }, customerSaveError: (error) => error.message,
    listOrders: async () => [], listCustomers: async () => [{ id: 'z', fullName: 'Zara', contact: '123' }, { id: 'a', fullName: 'Asha', contact: '456' }, { id: 'unicode', fullName: 'આશા Élodie', contact: '789' }],
    listOrderProducts: async (_db, type) => type === 'items' ? [{ id: 'sweet', name: 'Kaju Katli', active: true, defaultSellingPrice: 1200, sellingPrice500Gm: 600 }] : type === 'units' ? [{ id: 'kg', name: '1 KG', active: true }, { id: 'half', name: '500 GM', active: true }, { id: 'quarter', name: '250 GM', active: true }] : [],
    listInvoices: async () => [], getOrderTaking: async () => true, listMasterRecords: async () => [],
    callOperation: async (_fn, name, payload) => name === 'getOrderStock' ? (stockReads++, { items: [{ itemId: 'sweet', availableQty: 988000, unit: 'kg', status: 'available' }] }) : name === 'saveOrderDraft' ? (orderSaves.push(payload), { orderId: payload.orderId, orderNumber: 'SS-2026-000001', status: 'confirmed' }) : { rows: [], hasMore: false },
    saveCustomerDirect: async (_db, _auth, input, options) => { saved.push({ input, options }); return { customerId: options.customerId }; },
    visualViewport, innerHeight: 844, requestAnimationFrame(callback) { callback(); },
  };
  const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');
  vm.runInNewContext(`${source}\nthis.init = initOrderUi;`, Object.assign(context, { availableOrderUnits, itemUnitPrice, orderLineUnitLabel }));
  context.init({ db: {}, functions: {}, auth: { currentUser: { uid: 'admin' } } }).setSession({ uid: 'admin' }, { role: 'admin', active: true });
  await el('order-refresh').listeners.click();
  el('order-new').listeners.click();
  const html = fields.innerHTML;
  assert.match(html, /value="kg"[^>]*>KG/);
  assert.match(html, /value="500gm"[^>]*>500 GM/);
  assert.match(html, /value="250gm"[^>]*>250 GM/);
  assert.match(html, /name="quantity" type="text" value="1" inputmode="numeric" pattern="\[1-9\]\[0-9\]\*" title="Enter a whole number of at least 1" required/);
  assert.match(html, /Customer \*/);
  assert.match(html, /Search customer by name or phone number/);
  assert.match(html, /Add New Customer/);
  assert.doesNotMatch(html, /order-product-search|data-add-product/);
  assert.match(el('order-product-list').innerHTML, /data-unit-id="500gm"/);
  assert.match(el('order-product-list').innerHTML, /data-unit-id="kg"/);
  assert.doesNotMatch(el('order-product-list').innerHTML, /Add Item|data-add-product/);
  assert.match(el('order-product-filters').innerHTML, /data-product-category="kaju"/);
  let addedMarkup = '', pendingUnit = 'kg';
  const lineRows = [];
  el('order-lines').children = lineRows;
  el('order-lines').insertAdjacentHTML = (_position, value) => {
    addedMarkup = value;
    const fields = { kind: { value: 'item' }, productId: { value: 'sweet' }, unitId: { value: pendingUnit }, quantity: { value: String(/name="quantity" type="text" value="([^"]+)/.exec(value)?.[1] || '') } };
    const row = { querySelector(selector) { return fields[/\[name=([^\]]+)\]/.exec(selector)?.[1]]; }, remove() { lineRows.splice(lineRows.indexOf(row), 1); } };
    lineRows.push(row);
  };
  const unitQuantity = { value: '3', dataset: { kind: 'item', productId: 'sweet', unitId: 'kg' }, matches(selector) { return selector === '[data-unit-quantity]' || selector.startsWith('input:'); }, closest() { return { classList: { toggle() {} } }; }, setAttribute() {}, removeAttribute() {}, scrollIntoView() {} };
  fields.listeners.input({ target: unitQuantity });
  assert.match(addedMarkup, /name="quantity" type="text" value="3"/);
  assert.equal(unitQuantity.value, '3');
  assert.equal(lineRows.length, 1);
  pendingUnit = '500gm';
  const halfQuantity = { ...unitQuantity, value: '2', dataset: { kind: 'item', productId: 'sweet', unitId: '500gm' } };
  fields.listeners.input({ target: halfQuantity });
  assert.equal(lineRows.length, 2);
  assert.equal(lineRows[0].querySelector('[name=quantity]').value, '3');
  unitQuantity.value = '0';
  fields.listeners.input({ target: unitQuantity });
  assert.equal(lineRows.length, 1);
  assert.equal(lineRows[0].querySelector('[name=unitId]').value, '500gm');
  addedMarkup = '';
  unitQuantity.value = '1.5';
  fields.listeners.input({ target: unitQuantity });
  assert.equal(addedMarkup, '');
  lineRows.length = 0;
  context.document.activeElement = unitQuantity;
  visualViewport.height = 480;
  visualViewport.listeners.resize();
  assert.equal(dialogClasses.has('order-keyboard-open'), true);
  assert.equal(dialogStyles.get('--order-visible-height'), '480px');
  visualViewport.height = 844;
  visualViewport.listeners.resize();
  assert.equal(dialogClasses.has('order-keyboard-open'), false);
  assert.equal(dialogStyles.has('--order-visible-height'), false);
  assert.doesNotMatch(html, /Enter new customer details|<option value="__new__"/);
  el('order-customer-search').value = '456';
  fields.listeners.input({ target: { id: 'order-customer-search' } });
  assert.match(el('order-customer-options').innerHTML, /Asha/);
  assert.doesNotMatch(el('order-customer-options').innerHTML, /Zara/);
  el('order-customer-search').value = 'zArA';
  fields.listeners.input({ target: { id: 'order-customer-search' } });
  assert.match(el('order-customer-options').innerHTML, /Zara/);
  assert.doesNotMatch(el('order-customer-options').innerHTML, /Asha/);
  el('order-customer-search').value = 'missing';
  fields.listeners.input({ target: { id: 'order-customer-search' } });
  assert.match(el('order-customer-options').innerHTML, /No customers found.*Add New Customer/);
  fields.listeners.click({ target: { id: '', closest: (selector) => selector === '[data-customer-id]' ? { dataset: { customerId: 'a' } } : null, matches: () => false } });
  assert.equal(el('order-customer').value, 'a');
  const search = el('order-customer-search'); search.id = 'order-customer-search'; search.matches = () => false;
  assert.equal(search.value, 'Asha');
  fields.listeners.focusin({ target: search });
  assert.equal(search.value, '');
  assert.equal(el('order-customer').value, 'a');
  search.value = 'A'; fields.listeners.input({ target: search });
  assert.equal(search.value, 'A');
  assert.equal(el('order-customer').value, '');
  search.value = ''; fields.listeners.input({ target: search });
  assert.equal(search.value, '');
  fields.listeners.click({ target: { id: '', closest: (selector) => selector === '[data-customer-id]' ? { dataset: { customerId: 'unicode' } } : null, matches: () => false } });
  assert.equal(search.value, 'આશા Élodie');
  fields.listeners.focusin({ target: search });
  fields.listeners.focusout({ target: search });
  assert.equal(search.value, 'આશા Élodie');
  fields.listeners.click({ target: { id: '', closest: (selector) => selector === '[data-customer-id]' ? { dataset: { customerId: 'a' } } : null, matches: () => false } });
  pendingUnit = 'kg'; unitQuantity.value = '2'; fields.listeners.input({ target: unitQuantity });
  let reviewPresent = false, reviewMarkup = '';
  const review = { set outerHTML(value) { reviewMarkup = value; }, remove() { reviewPresent = false; } };
  const nextButton = { textContent: '' }, backButton = { hidden: true, textContent: '' };
  fields.querySelector = (selector) => selector === '#order-customer' ? el('order-customer') : selector === 'textarea[name=notes]' ? { closest: () => ({}) } : selector === '[name=notes]' ? { value: 'Keep this note' } : selector === '.order-entry-lines' || selector === '.order-product-picker' || selector === '.order-customer-choice' ? {} : selector === '.order-flow-header h3' || selector === '.order-step-subtitle' ? { textContent: '' } : selector === '#order-step-next' ? nextButton : selector === '#order-step-back' ? backButton : selector === '.order-review-panel' && reviewPresent ? review : selector === '.order-flow-actions' ? { insertAdjacentHTML(_position, value) { reviewPresent = true; reviewMarkup = value; } } : null;
  const clickTarget = (name, data) => ({ closest(selector) { return selector === name ? { dataset: data || {} } : null; } });
  fields.listeners.click({ target: clickTarget('#order-step-next') });
  assert.equal(nextButton.textContent, 'Continue to Review');
  fields.listeners.click({ target: clickTarget('#order-step-next') });
  assert.equal(nextButton.textContent, 'Save Order');
  assert.match(reviewMarkup, /Edit Items/);
  assert.match(reviewMarkup, /Keep this note/);
  assert.equal(orderSaves.length, 0);
  fields.listeners.click({ target: clickTarget('[data-edit-order-step]', { editOrderStep: '2' }) });
  assert.equal(nextButton.textContent, 'Continue to Review');
  assert.equal(lineRows[0].querySelector('[name=quantity]').value, '2');
  fields.listeners.click({ target: clickTarget('#order-step-next') });
  assert.equal(backButton.textContent, 'Back to Items');
  fields.listeners.click({ target: clickTarget('#order-step-back') });
  assert.equal(nextButton.textContent, 'Continue to Review');
  assert.equal(orderSaves.length, 0);
  delete fields.querySelector;
  lineRows.length = 0;
  assert.match(html, /Kaju Katli — ₹1,200\.00/);
  assert.match(html, /Available: 988 kg/);
  assert.doesNotMatch(html, /On hand:|Reserved:|Available: 988 kg<\/option>/);
  const readsBeforeChange = stockReads;
  fields.listeners.change({ target: { name: 'productId', id: '' } });
  await Promise.resolve();
  assert.ok(stockReads > readsBeforeChange);
  const preserved = current();
  el('order-customer').value = '__new__';
  fields.listeners.click({ target: { id: 'order-add-customer', matches: () => false } });
  assert.equal(el('order-dialog-title').textContent, 'Add customer');
  el('order-dialog-cancel').listeners.click();
  assert.equal(current(), preserved);
  assert.equal(current().note, 'keep my order note');
  fields.listeners.click({ target: { id: 'order-add-customer', matches: () => false } });
  await el('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].options.customerId, 'customer-request-1');
  assert.equal(el('order-customer').value, 'customer-request-1');
  assert.equal(current(), preserved);
  assert.equal(el('order-dialog').open, true);
  const added = [];
  el('order-lines').insertAdjacentHTML = (_position, html) => added.push(html);
  fields.listeners.click({ target: { id: 'order-add-line', matches: () => false } });
  assert.equal(added.length, 1);
  assert.match(added[0], /Kaju Katli — ₹1,200\.00/);

  // A normal User's modal stores details locally; the trusted order save creates
  // customer and order together, without a standalone customer write.
  el('order-dialog').close();
  context.init({ db: {}, functions: {}, auth: { currentUser: { uid: 'user-1' } } }).setSession({ uid: 'user-1' }, { role: 'user', active: true });
  await el('order-refresh').listeners.click();
  el('order-new').listeners.click();
  assert.match(fields.innerHTML, /value="kg"[^>]*>KG/);
  assert.match(fields.innerHTML, /value="500gm"[^>]*>500 GM/);
  assert.doesNotMatch(fields.innerHTML, /250 GM|250gm/);
  assert.doesNotMatch(el('order-product-list').innerHTML, /data-unit-id="250gm"|Special product/);
  el('order-customer').value = '__new__';
  fields.listeners.click({ target: { id: 'order-add-customer', matches: () => false } });
  await el('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(saved.length, 1);
  assert.match(el('order-customer-search').value, /New Customer/);
  assert.equal(el('order-customer').value, '__new__');
  Object.assign(values, { customerId: '__new__', orderDate: '2026-10-10', deliveryDate: '', notes: 'Keep this note' });
  // This legacy form harness submits directly; the step guard is covered by the real UI path.
  dialogClasses.delete('order-create-mode');
  let orderQuantity = '0.999';
  el('order-lines').children = [{ querySelector(selector) { return { value: selector === '[name=kind]' ? 'item' : selector === '[name=productId]' ? 'sweet' : orderQuantity }; } }];
  await el('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(orderSaves.length, 0);
  assert.match(el('order-form-error').textContent, /whole-number quantity/);
  orderQuantity = '2';
  await el('order-form').listeners.submit({ preventDefault() {}, currentTarget: {} });
  assert.equal(orderSaves.length, 1);
  assert.equal(orderSaves[0].newCustomer.fullName, 'New Customer');
  assert.equal(orderSaves[0].lines[0].quantityQty, 2000);
  assert.equal(orderSaves[0].notes, 'Keep this note');
  assert.ok(toasts.includes('Order SS-2026-000001 saved.'));
});

test('Admin may edit special lines; assigned User can view the saved special order', async () => {
  const nodes = new Map();
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', listeners: {}, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll() { return []; }, showModal() {}, close() {} }); return nodes.get(id); };
  const order = { id: 'order-1', orderNumber: 'SS-1', ownerUid: 'user-1', assignedUserId: 'user-1', customerId: 'customer-1', customerSnapshot: { fullName: 'Asha' }, status: 'draft', orderDate: '2026-10-10', lines: [{ kind: 'item', productId: 'sweet', quantityQty: 1000, orderUnitId: 'half', orderUnitName: '500 GM', itemSnapshot: { name: 'Kaju Katli', unitSymbol: 'kg' } }, { kind: 'special', productId: 'combo', quantityQty: 1000, specialSnapshot: { name: 'Gift Box' } }] };
  const context = {
    document: { getElementById: el, addEventListener() {}, querySelector() { return null; } }, isStaff, validateProfile, hasPermission, showToast() {},
    listOrders: async () => [order], listCustomers: async () => [{ id: 'customer-1', fullName: 'Asha', contact: '123' }],
    listOrderProducts: async (_db, type) => type === 'items' ? [{ id: 'sweet', name: 'Kaju Katli', active: true, defaultSellingPrice: 1200 }] : [{ id: 'combo', name: 'Gift Box', active: true, finalPricePaise: 160000, components: [{ itemId: 'sweet', quantityQty: 1000 }] }],
    listInvoices: async () => [], getOrderTaking: async () => true, listMasterRecords: async () => [],
    callOperation: async (_fn, name) => { if (name === 'getOrderStock') throw new Error('Network unavailable'); return { rows: [], hasMore: false }; },
  };
  const source = readFileSync(new URL('../js/order-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function initOrderUi', 'function initOrderUi');
  vm.runInNewContext(`${source}\nthis.init = initOrderUi;`, Object.assign(context, { availableOrderUnits, itemUnitPrice, orderLineUnitLabel }));
  const ui = context.init({ db: {}, functions: {}, auth: {} });
  ui.setSession({ uid: 'admin-1' }, { role: 'admin', active: true });
  await el('order-refresh').listeners.click();
  el('order-body').listeners.click({ target: { closest: () => ({ dataset: { action: 'editOrder', id: 'order-1' } }) } });
  const html = el('order-fields').innerHTML;
  assert.equal((html.match(/class="ops-line order-entry-line"/g) || []).length, 2);
  assert.match(html, /Choose an active permitted unit/);
  assert.match(html, /Kaju Katli — ₹1,200\.00/);
  assert.match(html, /Gift Box — ₹1,600\.00/);
  assert.equal((html.match(/Available: Unavailable/g) || []).length, 2);
  assert.doesNotMatch(html, /On hand:|Reserved:|Low stock|Out of stock/);
  el('special-new').listeners.click();
  assert.match(el('order-fields').innerHTML, /Final selling price/);
  assert.match(el('order-fields').innerHTML, /name="price" type="number"/);
  ui.setSession({ uid: 'user-1' }, { role: 'user', active: true });
  await el('order-refresh').listeners.click();
  assert.match(el('order-body').innerHTML, /data-action="viewOrder"/);
  assert.doesNotMatch(el('order-body').innerHTML, /data-action="editOrder"|data-action="confirmOrder"|data-action="archiveOrder"|data-action="cancelOrder"/);
  el('order-body').listeners.click({ target: { closest: () => ({ dataset: { action: 'viewOrder', id: 'order-1' } }) } });
  assert.match(el('order-fields').innerHTML, /Gift Box/);
  assert.match(el('order-fields').innerHTML, /500 GM/);
  assert.equal(el('order-dialog-save').hidden, true);
  el('order-new').listeners.click();
  assert.doesNotMatch(el('order-fields').innerHTML, /Special product/);
});

test('order entry CSS keeps product wider and stacks fields on mobile', () => {
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.order-customer-choice\{grid-column:1\/-1;display:flex;flex-direction:column/);
  assert.match(css, /@media\(max-width:480px\)\{\.order-add-customer\{width:100%/);
  assert.match(css, /\.order-dialog \.order-entry-line\{[^}]*grid-template-columns:minmax\(135px,170px\) minmax\(250px,1fr\)/);
  assert.match(css, /@media\(max-width:680px\)\{\.order-dialog \.order-entry-line\{[^}]*grid-template-areas:"type quantity" "product product"/);
});
