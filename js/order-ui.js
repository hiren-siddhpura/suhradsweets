import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { getOrderTaking, listCustomers, listOrderProducts, listOrders } from './order-data.js';
import { listMasterRecords } from './master-data.js';
import { downloadXlsx } from './xlsx-export.js';
import { saveCustomerDirect } from './customer-data.js';
import { customerSaveError } from './customer-validation.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rupees = (paise) => `₹${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (milli) => ((milli || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const empty = (count, label) => `<tr><td colspan="${count}" class="empty-cell">${esc(label)}</td></tr>`;
const cleanError = (error) => error?.message?.replace(/^.*?: /, '') || 'Operation failed. Try again.';
const field = (label, name, type = 'text', value = '', attrs = '') => `<label class="ops-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\s()-]/g, '');
const toMilli = (value) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) throw new Error('Use up to three decimal places for quantity.'); return Math.round(n * 1000); };
const toPaise = (value) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-7) throw new Error('Use up to two decimal places for price.'); return Math.round(n * 100); };

async function exportBook(name, sheets) {
  try {
    await downloadXlsx(name, sheets);
  } catch { showToast('XLSX export could not load. Check your connection.', 'toast-error'); }
}

export function initOrderUi({ db, functions, auth, mode }) {
  let user = null, profile = null, orders = [], customers = [], items = [], specials = [], users = [], acceptingOrders = true;
  let action = '', targetId = '', pendingOrderId = '', pendingCustomerId = '', saving = false;
  let sessionVersion = 0;
  const staff = () => isStaff(profile);

  async function refresh(page) {
    if (!profile) return;
    const version = sessionVersion;
    const message = $(`${page === 'specials' ? 'special' : page === 'orders' ? 'order' : 'customer'}-message`);
    message.textContent = 'Loading records…';
    try {
      const privileged = staff();
      const scopedUid = privileged ? null : user.uid;
      if (page === 'customers') {
        const scopedOrders = scopedUid ? await listOrders(db, scopedUid) : [];
        const rows = await listCustomers(db, scopedUid, scopedOrders);
        if (version !== sessionVersion) return;
        orders = scopedOrders; customers = rows;
        renderCustomers();
      } else if (page === 'orders') {
        const scopedOrders = await listOrders(db, scopedUid);
        const [customerRows, itemRows, specialRows, control, userRows] = await Promise.all([
          listCustomers(db, scopedUid, scopedOrders), listOrderProducts(db, 'items', privileged), listOrderProducts(db, 'specialProducts', privileged), getOrderTaking(db), privileged ? listMasterRecords(db, 'users') : Promise.resolve([]),
        ]);
        if (version !== sessionVersion) return;
        orders = scopedOrders; customers = customerRows; items = itemRows; specials = specialRows; acceptingOrders = control; users = userRows;
        renderOrders();
      } else if (page === 'specials' && staff()) {
        const [itemRows, specialRows] = await Promise.all([listOrderProducts(db, 'items', true), listOrderProducts(db, 'specialProducts', true)]);
        if (version !== sessionVersion) return;
        items = itemRows; specials = specialRows;
        renderSpecials();
      }
      message.textContent = '';
    } catch (error) { if (version === sessionVersion) { console.error('Could not load orders:', error); message.textContent = `Could not load records: ${cleanError(error)}`; } }
  }

  const filteredCustomers = () => customers.filter((customer) => `${customer.fullName} ${customer.contact}`.toLowerCase().includes($('customer-search').value.toLowerCase())).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const filteredOrders = () => orders.filter((order) => {
    const search = $('order-search').value.toLowerCase();
    return (!search || `${order.orderNumber} ${order.customerSnapshot?.fullName} ${order.customerSnapshot?.contact}`.toLowerCase().includes(search))
      && (!$('order-status').value || order.status === $('order-status').value)
      && (!$('order-user').value || order.assignedUserId === $('order-user').value)
      && (!$('order-from').value || order.orderDate >= $('order-from').value)
      && (!$('order-to').value || order.orderDate <= $('order-to').value);
  }).sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.orderNumber.localeCompare(a.orderNumber));
  const filteredSpecials = () => specials.filter((special) => {
    const search = $('special-search').value.toLowerCase();
    const status = $('special-status').value;
    return (!search || `${special.name} ${special.components?.map((p) => p.itemSnapshot?.name).join(' ')}`.toLowerCase().includes(search)) && (!status || special.active === (status === 'active'));
  }).sort((a, b) => a.name.localeCompare(b.name));

  function renderCustomers() {
    $('customer-new').hidden = !staff();
    const rows = filteredCustomers();
    $('customer-summary').innerHTML = `<div class="card ops-stat"><span>Visible customers</span><strong>${rows.length}</strong></div>${staff() ? `<div class="card ops-stat"><span>Sabha customers</span><strong>${rows.filter((c) => c.sabha).length}</strong></div><div class="card ops-stat"><span>Areas</span><strong>${new Set(rows.map((c) => c.area)).size}</strong></div>` : ''}`;
    $('customer-body').innerHTML = rows.length ? rows.map((c) => `<tr><td>${esc(c.fullName)}</td><td>${esc(c.contact)}</td><td>${esc(c.area)}</td><td>${esc(c.address)}</td><td>${staff() ? c.sabha ? 'Yes' : 'No' : '—'}</td><td>${staff() ? esc(c.ownerUserIds?.length || 0) : '—'}</td><td>${staff() ? `<button class="ops-link" type="button" data-id="${esc(c.id)}" data-action="editCustomer">Edit</button> ${mode === 'emulator' ? `<button class="ops-link" type="button" data-id="${esc(c.id)}" data-action="deleteCustomer">Delete</button>` : ''}` : ''}</td></tr>`).join('') : empty(7, 'No customers match your search or order access.');
  }
  function renderOrders() {
    $('order-intake').hidden = !staff();
    $('order-intake').textContent = acceptingOrders ? 'Order-taking: open' : 'Order-taking: paused';
    $('order-new').disabled = !acceptingOrders;
    $('order-user').hidden = !staff();
    const selectedUser = $('order-user').value;
    $('order-user').innerHTML = '<option value="">All users</option>' + users.filter((u) => u.role === 'user').map((u) => `<option value="${esc(u.id)}">${esc(u.displayName || u.id)}</option>`).join('');
    $('order-user').value = selectedUser;
    const rows = filteredOrders();
    $('order-cards').innerHTML = `<div class="card ops-stat"><span>Visible orders</span><strong>${rows.length}</strong></div><div class="card ops-stat"><span>Open orders</span><strong>${rows.filter((o) => !['cancelled', 'delivered'].includes(o.status)).length}</strong></div><div class="card ops-stat"><span>Confirmed value</span><strong>${rupees(rows.filter((o) => !['draft', 'cancelled'].includes(o.status)).reduce((sum, o) => sum + (o.grandTotal || 0), 0))}</strong></div>`;
    $('order-body').innerHTML = rows.length ? rows.map((o) => {
      const actions = [o.status === 'draft' && acceptingOrders ? `<button data-action="editOrder" data-id="${esc(o.id)}">Edit</button><button data-action="confirmOrder" data-id="${esc(o.id)}">Confirm</button>` : '',
        ['draft', 'confirmed', 'in_preparation', 'ready'].includes(o.status) && (staff() || o.status === 'draft') ? `<button data-action="cancelOrder" data-id="${esc(o.id)}">Cancel</button>` : '',
        staff() && ['confirmed', 'in_preparation', 'ready'].includes(o.status) ? `<button data-action="advanceOrder" data-id="${esc(o.id)}">Next status</button>` : '',
        staff() && ['confirmed', 'in_preparation', 'ready', 'delivered'].includes(o.status) ? `<button data-action="invoiceOrder" data-id="${esc(o.id)}">Create invoice</button>` : ''].filter(Boolean).join('');
      return `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.customerSnapshot?.fullName)}</td><td>${esc(o.orderDate)}</td><td>${esc(users.find((u) => u.id === o.assignedUserId)?.displayName || o.assignedUserId)}</td><td>${esc(o.status)}</td><td>${rupees(o.grandTotal)}</td><td class="ops-actions">${actions}</td></tr>`;
    }).join('') : empty(7, 'No orders match these filters.');
  }
  function renderSpecials() {
    const rows = filteredSpecials();
    $('special-body').innerHTML = rows.length ? rows.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.components?.map((p) => `${p.itemSnapshot?.name} ${qtyText(p.quantityQty)} ${p.itemSnapshot?.unitSymbol}`).join(' + '))}</td><td>${rupees(s.finalPricePaise)}</td><td>${s.active ? 'Active' : 'Inactive'}</td><td><button class="ops-link" type="button" data-id="${esc(s.id)}" data-action="editSpecial">Edit</button></td></tr>`).join('') : empty(5, 'No combinations match the filters.');
  }

  function customerFields(c = {}, prefix = '') {
    return `${field('Full name', `${prefix}fullName`, 'text', c.fullName, 'required maxlength="120"')}${field('Contact', `${prefix}contact`, 'text', c.contact, 'required maxlength="80"')}${field('Address', `${prefix}address`, 'text', c.address, 'required maxlength="300"')}${field('Area', `${prefix}area`, 'text', c.area, 'required maxlength="100"')}${field('Date of birth (optional)', `${prefix}dateOfBirth`, 'date', c.dateOfBirth || '')}<label class="ops-field">Sabha<select name="${prefix}sabha"><option value="false" ${!c.sabha ? 'selected' : ''}>No</option><option value="true" ${c.sabha ? 'selected' : ''}>Yes</option></select></label>`;
  }
  const readCustomerFields = (data, prefix = '') => ({ fullName: data.get(`${prefix}fullName`), contact: data.get(`${prefix}contact`), address: data.get(`${prefix}address`), area: data.get(`${prefix}area`), dateOfBirth: data.get(`${prefix}dateOfBirth`) || null, sabha: data.get(`${prefix}sabha`) === 'true' });
  function itemOptions(selected = '') { return items.filter((i) => i.active).map((i) => { let price = 'price unavailable'; try { price = rupees(toPaise(i.defaultSellingPrice)); } catch { /* Backend rejects invalid catalog prices. */ } return `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(i.name)} · ${price}</option>`; }).join(''); }
  function productOptions(kind, selected = '') { return kind === 'item' ? itemOptions(selected) : specials.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)} · ${rupees(s.finalPricePaise)}</option>`).join(''); }
  function orderLine(line = {}) { const kind = line.kind || 'item'; return `<div class="ops-line"><label>Type<select name="kind"><option value="item" ${kind === 'item' ? 'selected' : ''}>Regular item</option><option value="special" ${kind === 'special' ? 'selected' : ''}>Special product</option></select></label><label>Product<select name="productId">${productOptions(kind, line.productId)}</select></label>${field('Quantity', 'quantity', 'number', line.quantityQty ? line.quantityQty / 1000 : 1, 'min="0.001" step="0.001" required')}<button type="button" class="button button-outline" data-remove-line>Remove</button></div>`; }
  function componentLine(part = {}) { return `<div class="ops-line"><label>Item<select name="itemId">${itemOptions(part.itemId)}</select></label>${field('Quantity', 'quantity', 'number', part.quantityQty ? part.quantityQty / 1000 : 1, 'min="0.001" step="0.001" required')}<button type="button" class="button button-outline" data-remove-line>Remove</button></div>`; }

  function openDialog(nextAction, id = '') {
    if (saving) return;
    if (nextAction === 'customer') pendingCustomerId = id || crypto.randomUUID();
    action = nextAction; targetId = id; $('order-form-error').hidden = true;
    $('order-dialog-save').textContent = nextAction === 'deleteCustomer' ? 'Delete customer' : 'Save';
    const c = customers.find((row) => row.id === id), o = orders.find((row) => row.id === id), s = specials.find((row) => row.id === id);
    $('order-dialog-title').textContent = ({ customer: c ? 'Edit customer' : 'Add customer', order: o ? `Edit ${o.orderNumber}` : 'New order', special: s ? 'Edit combination' : 'Add combination', cancel: 'Cancel order', intake: 'Order-taking', invoice: 'Create invoice' })[nextAction];
    if (nextAction === 'customer') $('order-fields').innerHTML = customerFields(c);
    if (nextAction === 'deleteCustomer') {
      if (!staff() || !c) return;
      $('order-dialog-title').textContent = 'Delete customer';
      $('order-fields').innerHTML = `<p>Permanently delete <strong>${esc(c.fullName)}</strong>?</p><p>This is allowed only if no transaction records have ever been linked to this customer. This action cannot be undone.</p>`;
    }
    if (nextAction === 'order') {
      const selectedCustomer = o?.customerId || customers[0]?.id || '__new__';
      $('order-fields').innerHTML = `<label class="ops-field">Customer<select name="customerId" id="order-customer"><option value="__new__" ${selectedCustomer === '__new__' ? 'selected' : ''}>+ New customer</option>${customers.map((row) => `<option value="${esc(row.id)}" ${row.id === selectedCustomer ? 'selected' : ''}>${esc(row.fullName)} · ${esc(row.contact)}</option>`).join('')}</select></label>${staff() ? `<label class="ops-field">Assigned User<select name="assignedUserId" required>${users.filter((row) => row.role === 'user' && row.active).map((row) => `<option value="${esc(row.id)}" ${o?.assignedUserId === row.id ? 'selected' : ''}>${esc(row.displayName || row.id)}</option>`).join('')}</select></label>` : ''}<div id="order-new-customer" class="ops-inline-fields" ${selectedCustomer !== '__new__' ? 'hidden' : ''}>${customerFields({}, 'new_')}</div>${field('Order date', 'orderDate', 'date', o?.orderDate || new Date().toISOString().slice(0, 10), 'required')}${field('Delivery date (optional)', 'deliveryDate', 'date', o?.deliveryDate || '')}<div class="ops-lines"><strong>Order lines</strong><div id="order-lines">${(o?.lines || [{}]).map(orderLine).join('')}</div><button id="order-add-line" class="button button-outline" type="button">Add line</button><p class="muted">Prices are checked again when the order is confirmed. Special products use whole combos.</p></div><label class="ops-field">Notes<textarea name="notes" maxlength="1000">${esc(o?.notes || '')}</textarea></label>`;
      toggleNewCustomer();
    }
    if (nextAction === 'special') $('order-fields').innerHTML = `${field('Name', 'name', 'text', s?.name, 'required maxlength="120"')}${field('Final selling price (₹)', 'price', 'number', s ? s.finalPricePaise / 100 : '', 'min="0" step="0.01" required')}<label class="ops-field">Description<textarea name="description" maxlength="500">${esc(s?.description || '')}</textarea></label><label class="ops-field">Status<select name="active"><option value="true" ${s?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${s?.active === false ? 'selected' : ''}>Inactive</option></select></label><div class="ops-lines"><strong>Recipe: 2 to 4 distinct items</strong><div id="special-components">${(s?.components || [{}, {}]).map(componentLine).join('')}</div><button id="special-add-component" class="button button-outline" type="button">Add component</button></div>`;
    if (nextAction === 'cancel') $('order-fields').innerHTML = `<p>Cancel ${esc(o?.orderNumber)}? Stock will be restored for a confirmed, undelivered order. Invoiced orders need a separate return workflow.</p>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'intake') $('order-fields').innerHTML = `<p>Order-taking is currently ${acceptingOrders ? 'open' : 'paused'}.</p><label class="ops-field">New status<select name="acceptingOrders"><option value="false">Pause</option><option value="true">Resume</option></select></label>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'invoice') $('order-fields').innerHTML = `<p>Create one invoice from ${esc(o?.orderNumber)}? The invoice will contain the confirmed customer and price snapshots. Sabha is excluded.</p>`;
    $('order-dialog').showModal();
  }
  function toggleNewCustomer() {
    const pane = $('order-new-customer'); if (!pane) return;
    const isNew = $('order-customer').value === '__new__'; pane.hidden = !isNew;
    pane.querySelectorAll('[required]').forEach((input) => { input.disabled = !isNew; });
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const data = new FormData(event.currentTarget), button = $('order-dialog-save');
    button.disabled = true; $('order-form-error').hidden = true;
    try {
      let name, payload;
      if (action === 'deleteCustomer') { if (!staff()) throw new Error('Staff access is required.'); name = 'deleteCustomer'; payload = { customerId: targetId }; } else if (action === 'customer') {
        if (!staff()) throw new Error('Staff access is required.');
        payload = readCustomerFields(data);
        const duplicate = customers.find((c) => c.id !== targetId && normalize(c.contact) === normalize(payload.contact));
        if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}.`);
      } else if (action === 'special') {
        if (!staff()) throw new Error('Staff access is required.');
        payload = { specialId: targetId || undefined, name: data.get('name'), description: data.get('description'), finalPricePaise: toPaise(data.get('price')), active: data.get('active') === 'true', components: [...$('special-components').children].map((row) => { const itemId = row.querySelector('[name=itemId]').value; return { itemId, unitId: items.find((item) => item.id === itemId)?.defaultUnitId, quantityQty: toMilli(row.querySelector('[name=quantity]').value) }; }) };
        name = 'saveSpecialProduct';
      } else if (action === 'order') {
        const selected = data.get('customerId');
        payload = { orderId: targetId || pendingOrderId || crypto.randomUUID(), customerId: selected === '__new__' ? undefined : selected, newCustomer: selected === '__new__' ? readCustomerFields(data, 'new_') : undefined, assignedUserId: staff() ? data.get('assignedUserId') : user.uid, orderDate: data.get('orderDate'), deliveryDate: data.get('deliveryDate') || null, notes: data.get('notes'), lines: [...$('order-lines').children].map((row) => ({ kind: row.querySelector('[name=kind]').value, productId: row.querySelector('[name=productId]').value, quantityQty: toMilli(row.querySelector('[name=quantity]').value) })) };
        if (selected === '__new__') {
          const duplicate = customers.find((c) => normalize(c.contact) === normalize(payload.newCustomer.contact));
          if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}. Select that customer.`);
        }
        pendingOrderId = payload.orderId; name = 'saveOrderDraft';
      } else if (action === 'cancel') { name = 'cancelOrder'; payload = { orderId: targetId, reason: data.get('reason') }; }
      else if (action === 'intake') { name = 'setOrderTaking'; payload = { acceptingOrders: data.get('acceptingOrders') === 'true', reason: data.get('reason') }; }
      else { name = 'createInvoiceFromOrder'; payload = { orderId: targetId }; }
      if (action === 'customer') await saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: !targetId });
      else await callOperation(functions, name, payload);
      pendingOrderId = ''; $('order-dialog').close(); showToast(action === 'deleteCustomer' ? 'Customer deleted.' : 'Saved successfully.');
      await refresh(['customer', 'deleteCustomer'].includes(action) ? 'customers' : action === 'special' ? 'specials' : 'orders');
    } catch (error) { $('order-form-error').textContent = action === 'customer' ? customerSaveError(error) : cleanError(error); $('order-form-error').hidden = false; }
    finally { saving = false; button.disabled = false; }
  }

  async function runOrderAction(nextAction, id) {
    const o = orders.find((row) => row.id === id); if (!o) return;
    if (nextAction === 'editOrder') return openDialog('order', id);
    if (nextAction === 'cancelOrder') return openDialog('cancel', id);
    if (nextAction === 'invoiceOrder') return openDialog('invoice', id);
    try {
      if (nextAction === 'confirmOrder') await callOperation(functions, 'confirmOrder', { orderId: id });
      if (nextAction === 'advanceOrder') {
        const transitions = { confirmed: 'in_preparation', in_preparation: 'ready', ready: 'delivered' };
        await callOperation(functions, 'advanceOrder', { orderId: id, nextStatus: transitions[o.status] });
      }
      showToast('Order updated.'); await refresh('orders');
    } catch (error) { showToast(cleanError(error), 'toast-error'); }
  }

  document.addEventListener('oms:pagechange', (event) => { if (['customers', 'orders', 'specials'].includes(event.detail.page) && profile) refresh(event.detail.page); });
  $('customer-new').addEventListener('click', () => openDialog('customer'));
  $('order-new').addEventListener('click', () => { pendingOrderId = ''; openDialog('order'); });
  $('special-new').addEventListener('click', () => openDialog('special'));
  $('order-intake').addEventListener('click', () => openDialog('intake'));
  ['customers', 'orders', 'specials'].forEach((page) => $(page === 'specials' ? 'special-refresh' : page.slice(0, -1) + '-refresh').addEventListener('click', () => refresh(page)));
  ['customer-search'].forEach((id) => $(id).addEventListener('input', renderCustomers));
  ['order-search', 'order-status', 'order-user', 'order-from', 'order-to'].forEach((id) => $(id).addEventListener('input', renderOrders));
  ['special-search', 'special-status'].forEach((id) => $(id).addEventListener('input', renderSpecials));
  $('customer-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog(button.dataset.action === 'deleteCustomer' ? 'deleteCustomer' : 'customer', button.dataset.id); });
  $('special-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog('special', button.dataset.id); });
  $('order-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) runOrderAction(button.dataset.action, button.dataset.id); });
  $('order-fields').addEventListener('change', (event) => {
    if (event.target.id === 'order-customer') toggleNewCustomer();
    if (event.target.name === 'kind') event.target.closest('.ops-line').querySelector('[name=productId]').innerHTML = productOptions(event.target.value);
  });
  $('order-fields').addEventListener('click', (event) => {
    if (event.target.id === 'order-add-line') $('order-lines').insertAdjacentHTML('beforeend', orderLine());
    if (event.target.id === 'special-add-component' && $('special-components').children.length < 4) $('special-components').insertAdjacentHTML('beforeend', componentLine());
    if (event.target.matches('[data-remove-line]')) { const holder = event.target.closest('.ops-lines').querySelector('div[id]'); if (holder.children.length > (action === 'special' ? 2 : 1)) event.target.closest('.ops-line').remove(); }
  });
  $('order-form').addEventListener('submit', submit);
  $('order-dialog-close').addEventListener('click', () => $('order-dialog').close());
  $('order-dialog-cancel').addEventListener('click', () => $('order-dialog').close());
  $('customer-export').addEventListener('click', () => exportBook('customers', [['Customers', filteredCustomers().map((c) => ({ Name: c.fullName, Contact: c.contact, Address: c.address, Area: c.area, ...(staff() ? { DateOfBirth: c.dateOfBirth, Sabha: c.sabha } : {}) }))]]));
  $('order-export').addEventListener('click', () => { const rows = filteredOrders(); exportBook('orders', [['Orders', rows.map((o) => ({ OrderNumber: o.orderNumber, Customer: o.customerSnapshot?.fullName, Date: o.orderDate, DeliveryDate: o.deliveryDate, AssignedUser: o.assignedUserId, Status: o.status, TotalRupees: (o.grandTotal || 0) / 100 }))], ['Lines', rows.flatMap((o) => o.lines?.map((l) => ({ OrderNumber: o.orderNumber, Product: l.kind === 'item' ? l.itemSnapshot?.name : l.specialSnapshot?.name, Quantity: l.quantityQty / 1000, UnitPriceRupees: l.unitPricePaise / 100, LineTotalRupees: l.lineTotalPaise / 100 })) || [])]]); });
  $('special-export').addEventListener('click', () => exportBook('specials', [['Special Products', filteredSpecials().map((s) => ({ Name: s.name, FinalPriceRupees: s.finalPricePaise / 100, Active: s.active, Components: s.components?.map((p) => `${p.itemSnapshot?.name}: ${qtyText(p.quantityQty)} ${p.itemSnapshot?.unitSymbol}`).join('; ') }))]]));

  return { setSession(nextUser, nextProfile) { sessionVersion++; user = nextUser; profile = nextProfile; orders = []; customers = []; items = []; specials = []; users = []; pendingOrderId = ''; ['customer-body', 'order-body', 'special-body', 'customer-summary', 'order-cards'].forEach((id) => { $(id).innerHTML = ''; }); $('order-user').value = ''; if (profile) { const page = document.querySelector('[data-page].is-active')?.dataset.page; if (['customers', 'orders', 'specials'].includes(page)) refresh(page); } } };
}
