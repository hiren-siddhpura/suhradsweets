import { isStaff, validateProfile } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { getOrderTaking, listCustomers, listOrderProducts, listOrders } from './order-data.js';
import { listMasterRecords } from './master-data.js';
import { downloadXlsx } from './xlsx-export.js';
import { saveCustomerDirect } from './customer-data.js';
import { customerSaveError, validateCustomerInput } from './customer-validation.js';
import { listInvoices } from './finance-data.js';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from './order-units.js';

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
  $('order-activity-type').insertAdjacentHTML?.('beforeend', '<option value="order.locked">Editing locked</option>');
  $('order-activity-order').insertAdjacentHTML?.('afterend', '<input id="order-activity-invoice" type="search" placeholder="Invoice ID" aria-label="Activity invoice"><input id="order-activity-payment" type="search" placeholder="Payment ID" aria-label="Activity payment">');
  let user = null, profile = null, orders = [], customers = [], items = [], specials = [], users = [], acceptingOrders = true;
  let invoiceIds = new Set(), stockAvailability = new Map(), stockMessage = '';
  let activityPage = 1, activityCursors = [null], activityRows = [], activityNext = null, activityHasMore = false, activityRevision = 0;
  let action = '', targetId = '', pendingOrderId = '', pendingCustomerId = '', pendingCustomerDetails = null, parkedOrder = null, saving = false;
  let sessionVersion = 0;
  const staff = () => isStaff(profile);
  const admin = () => !validateProfile(profile) && profile.role === 'admin';
  const eligibleUsers = () => [...new Map(users.filter(row => row.id && !validateProfile(row)).map(row => [row.id, row])).values()];
  const assignedUserName = (order) => {
    const uid = order.assignedUserId || order.ownerUid;
    const record = users.find((entry) => entry.id === uid);
    return record?.displayName || record?.fullName
      || (uid === user?.uid ? profile?.displayName || profile?.fullName : '')
      || order.assignedUserName || 'Unknown user';
  };

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
        const [customerRows, itemRows, specialRows, control, userRows, invoiceRows] = await Promise.all([
          listCustomers(db, scopedUid, scopedOrders), listOrderProducts(db, 'items', privileged), listOrderProducts(db, 'specialProducts', privileged), getOrderTaking(db), privileged ? listMasterRecords(db, 'users') : Promise.resolve([]), listInvoices(db, scopedUid),
        ]);
        if (version !== sessionVersion) return;
        orders = scopedOrders; customers = customerRows; items = itemRows; specials = specialRows; acceptingOrders = control; users = userRows;
        invoiceIds = new Set(invoiceRows.map((invoice) => invoice.orderId));
        await refreshStock();
        renderOrders();
        loadActivity(true);
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
      && (!$('order-archive').value || (order.archivedAt ? 'archived' : 'active') === $('order-archive').value)
      && (!admin() || !$('order-user').value || order.assignedUserId === $('order-user').value)
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
    $('order-user').hidden = !admin();
    const selectedUser = $('order-user').value;
    $('order-user').innerHTML = '<option value="">All users</option>' + eligibleUsers().map((u) => `<option value="${esc(u.id)}">${esc(u.displayName || u.fullName || u.id)}</option>`).join('');
    $('order-user').value = selectedUser;
    const rows = filteredOrders();
    $('order-cards').innerHTML = `<div class="card ops-stat"><span>Visible orders</span><strong>${rows.length}</strong></div><div class="card ops-stat"><span>Open orders</span><strong>${rows.filter((o) => !['cancelled', 'delivered'].includes(o.status)).length}</strong></div><div class="card ops-stat"><span>Confirmed value</span><strong>${rupees(rows.filter((o) => !['draft', 'cancelled'].includes(o.status)).reduce((sum, o) => sum + (o.grandTotal || 0), 0))}</strong></div>`;
    $('order-body').innerHTML = rows.length ? rows.map((o) => {
      const manageable = staff() || o.ownerUid === user?.uid;
      const specialOrder = o.lines?.some((line) => line.kind === 'special');
      const mayEdit = manageable && (!specialOrder || admin());
      const editableStatus = ['draft', 'confirmed', 'in_preparation', 'ready'].includes(o.status);
      const financialReason = invoiceIds.has(o.id) ? 'An invoice exists for this order.' : o.paymentRequestedAt ? 'Payment was requested for this order.' : '';
      const lockReason = financialReason || (o.archivedAt ? 'Restore this order to edit it.' : !acceptingOrders ? 'Order-taking is paused.' : '');
      const button = (kind, label, reason = '') => `<button type="button" data-action="${kind}" data-id="${esc(o.id)}" ${reason ? `disabled title="${esc(reason)}"` : ''}>${label}</button>`;
      const actions = [button('viewOrder', 'View'), mayEdit && editableStatus ? button('editOrder', 'Edit', lockReason) : '',
        o.status === 'draft' && mayEdit ? button('confirmOrder', 'Confirm', o.archivedAt ? 'Restore this order first.' : !acceptingOrders ? 'Order-taking is paused.' : '') : '',
        manageable && editableStatus && (!specialOrder || staff()) ? o.archivedAt ? button('restoreOrder', 'Restore', financialReason) : button('archiveOrder', 'Archive', financialReason) : '',
        editableStatus && (staff() || o.status === 'draft' && !specialOrder) ? button('cancelOrder', 'Cancel', o.archivedAt || invoiceIds.has(o.id) || o.paymentRequestedAt ? 'Financial or archive lock prevents cancellation.' : '') : '',
        staff() && ['confirmed', 'in_preparation', 'ready'].includes(o.status) ? button('advanceOrder', 'Next status', o.archivedAt ? 'Restore this order first.' : '') : '',
        staff() && ['confirmed', 'in_preparation', 'ready', 'delivered'].includes(o.status) && !invoiceIds.has(o.id) ? button('invoiceOrder', 'Create invoice', o.archivedAt ? 'Restore this order first.' : '') : '',
        invoiceIds.has(o.id) ? button('viewInvoice', 'View invoice') : '',
        !staff() && ['confirmed', 'in_preparation', 'ready', 'delivered'].includes(o.status) && !invoiceIds.has(o.id) ? '<span class="muted">Awaiting staff invoice</span>' : ''].filter(Boolean).join('');
      return `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.customerSnapshot?.fullName)}</td><td>${esc(o.orderDate)}</td><td>${esc(assignedUserName(o))}</td><td>${esc(o.archivedAt ? `${o.status} · Archived` : o.status)}</td><td>${rupees(o.grandTotal)}</td><td class="ops-actions">${actions}</td></tr>`;
    }).join('') : empty(7, 'No orders match these filters.');
  }
  function renderSpecials() {
    const rows = filteredSpecials();
    $('special-body').innerHTML = rows.length ? rows.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.components?.map((p) => `${p.itemSnapshot?.name} ${qtyText(p.quantityQty)} ${p.itemSnapshot?.unitSymbol}`).join(' + '))}</td><td>${rupees(s.finalPricePaise)}</td><td>${s.active ? 'Active' : 'Inactive'}</td><td><button class="ops-link" type="button" data-id="${esc(s.id)}" data-action="editSpecial">Edit</button></td></tr>`).join('') : empty(5, 'No combinations match the filters.');
  }

  function viewInvoice(orderNumber) {
    $('invoice-search').value = orderNumber || '';
    ['invoice-status', 'invoice-from', 'invoice-to'].forEach((id) => { $(id).value = ''; });
    document.querySelector('[data-page="invoices"]')?.click();
    $('invoice-search').dispatchEvent(new Event('input'));
  }

  function customerFields(c = {}, prefix = '') {
    return `${field('Full name', `${prefix}fullName`, 'text', c.fullName, 'required maxlength="120"')}${field('Contact', `${prefix}contact`, 'text', c.contact, 'required maxlength="80"')}${field('Address', `${prefix}address`, 'text', c.address, 'required maxlength="300"')}${field('Area', `${prefix}area`, 'text', c.area, 'required maxlength="100"')}${field('Date of birth (optional)', `${prefix}dateOfBirth`, 'date', c.dateOfBirth || '')}<label class="ops-field">Sabha<select name="${prefix}sabha"><option value="false" ${!c.sabha ? 'selected' : ''}>No</option><option value="true" ${c.sabha ? 'selected' : ''}>Yes</option></select></label>`;
  }
  const readCustomerFields = (data, prefix = '') => ({ fullName: data.get(`${prefix}fullName`), contact: data.get(`${prefix}contact`), address: data.get(`${prefix}address`), area: data.get(`${prefix}area`), dateOfBirth: data.get(`${prefix}dateOfBirth`) || null, sabha: data.get(`${prefix}sabha`) === 'true' });
  const stockIds = () => [...new Set([...items.filter((item) => item.active).map((item) => item.id), ...specials.filter((special) => special.active).flatMap((special) => special.components?.map((part) => part.itemId) || [])])];
  async function refreshStock() {
    stockAvailability = new Map(); stockMessage = '';
    try {
      const ids = stockIds();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await callOperation(functions, 'getOrderStock', { itemIds: ids.slice(offset, offset + 100) });
        for (const item of result?.items || []) stockAvailability.set(item.itemId, item);
      }
    } catch (error) { stockMessage = `Stock availability is unavailable: ${cleanError(error)}`; }
    updateStockLabels();
  }
  function productStock(kind, id) {
    if (kind === 'item') return stockAvailability.get(id) || null;
    const special = specials.find((entry) => entry.id === id);
    if (!special?.components?.length) return null;
    const parts = special.components.map((part) => ({ ...part, stock: stockAvailability.get(part.itemId) }));
    if (parts.some((part) => !part.stock || part.stock.availableQty == null || !part.quantityQty)) return null;
    const availableQty = Math.min(...parts.map((part) => Math.floor(part.stock.availableQty / part.quantityQty))) * 1000;
    return { availableQty, unit: 'combos', status: parts.some((part) => part.stock.status === 'blocked') ? 'blocked' : availableQty === 0 ? 'out_of_stock' : parts.some((part) => part.stock.status === 'low_stock') ? 'low_stock' : 'available' };
  }
  function stockLabel(kind, id) {
    const stock = productStock(kind, id);
    if (!stock || stock.availableQty == null) return 'Available: Unavailable';
    return `Available: ${qtyText(stock.availableQty)} ${stock.unit || ''}`.trim();
  }
  function stockNotice(kind, id) {
    if (!id) return '';
    const stock = productStock(kind, id);
    if (!stock || stock.availableQty == null) return 'Stock information is unavailable. Confirmation will check current stock.';
    if (stock?.status === 'blocked') return 'This product is blocked from new confirmations.';
    if (stock?.status === 'unavailable') return 'This product is unavailable for new confirmations.';
    return '';
  }
  function updateStockLabels() {
    const root = $('order-fields');
    const rows = root.querySelectorAll?.('#order-lines .ops-line') || [];
    for (const row of rows) {
      const kind = row.querySelector('[name=kind]')?.value, select = row.querySelector('[name=productId]');
      if (!select) continue;
      for (const option of select.options || []) {
        const product = kind === 'item' ? items.find((entry) => entry.id === option.value) : specials.find((entry) => entry.id === option.value);
        if (product) {
          let price = 'price unavailable';
          try { price = kind === 'item' ? rupees(toPaise(itemUnitPrice(product, row.querySelector('[name=unitId]')?.value || 'kg'))) : rupees(product.finalPricePaise); } catch { /* Invalid catalog prices remain unavailable. */ }
          option.textContent = `${product.name} — ${price}`;
        }
      }
      const hint = row.querySelector('.order-stock-hint'); if (hint) hint.textContent = stockLabel(kind, select.value);
      const notice = row.querySelector('.order-stock-warning'); if (notice) { notice.textContent = stockNotice(kind, select.value); notice.hidden = !notice.textContent; }
    }
    const message = $('order-stock-message'); if (message) message.textContent = stockMessage;
  }
  function stockWarning(lines, existing = null) {
    const needed = new Map();
    for (const line of lines) {
      if (line.kind === 'item') needed.set(line.productId, (needed.get(line.productId) || 0) + line.quantityQty);
      else for (const part of specials.find((entry) => entry.id === line.productId)?.components || []) needed.set(part.itemId, (needed.get(part.itemId) || 0) + part.quantityQty * line.quantityQty / 1000);
    }
    for (const [id, quantity] of needed) {
      const stock = stockAvailability.get(id);
      const additional = Math.max(0, quantity - (existing?.stockDeductions?.find((part) => part.itemId === id)?.quantityQty || 0));
      if (stock?.availableQty != null && (stock.status === 'blocked' && additional > 0 || additional > stock.availableQty)) return 'Requested quantity exceeds available stock or an item is blocked. Confirmation will be rejected until stock is available.';
    }
    return '';
  }
  function itemOptions(selected = '') { return items.filter((i) => i.active).map((i) => { let price = 'price unavailable'; try { price = rupees(toPaise(i.defaultSellingPrice)); } catch { /* Backend rejects invalid catalog prices. */ } return `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(i.name)} — ${price}</option>`; }).join(''); }
  function productOptions(kind, selected = '') { return kind === 'item' ? itemOptions(selected) : specials.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)} — ${rupees(s.finalPricePaise)}</option>`).join(''); }
  function orderLine(line = {}) {
    const kind = line.kind || 'item';
    const productId = line.productId || (kind === 'item' ? items.find((item) => item.active)?.id : specials.find((special) => special.active)?.id);
    const notice = stockNotice(kind, productId);
    const choices = availableOrderUnits(profile?.role);
    const legacy = kind === 'item' && line.productId && !line.orderUnitId;
    const selectedUnit = legacy ? '__legacy__' : line.orderUnitId || choices[0].id;
    const legacyOption = legacy ? `<option value="__legacy__" selected>Current: ${esc(line.itemSnapshot?.unitSymbol || 'item unit')}</option>` : '';
    const missingOption = line.orderUnitId && !choices.some((unit) => unit.id === line.orderUnitId) ? '<option value="" selected>Choose an active permitted unit</option>' : '';
    const unitField = kind === 'item' ? `<label class="order-line-unit">Unit<select name="unitId" required>${legacyOption}${missingOption}${choices.map((unit) => `<option value="${esc(unit.id)}" ${unit.id === selectedUnit ? 'selected' : ''}>${esc(unit.label)}</option>`).join('')}</select></label>` : '';
    return `<div class="ops-line order-entry-line"><label class="order-line-type">Type<select name="kind"><option value="item" ${kind === 'item' ? 'selected' : ''}>Regular item</option>${admin() ? `<option value="special" ${kind === 'special' ? 'selected' : ''}>Special product</option>` : ''}</select></label><label class="order-line-product">Product<select name="productId">${productOptions(kind, line.productId)}</select><small class="order-stock-hint">${esc(stockLabel(kind, productId))}</small><small class="order-stock-warning" ${notice ? '' : 'hidden'}>${esc(notice)}</small></label>${field('Quantity', 'quantity', 'number', line.quantityQty ? line.quantityQty / 1000 : 1, 'min="0.001" step="0.001" required')}${unitField}<button type="button" class="ops-link order-line-remove" data-remove-line aria-label="Remove order line">Remove</button></div>`;
  }
  function componentLine(part = {}) { return `<div class="ops-line"><label>Item<select name="itemId">${itemOptions(part.itemId)}</select></label>${field('Quantity', 'quantity', 'number', part.quantityQty ? part.quantityQty / 1000 : 1, 'min="0.001" step="0.001" required')}<button type="button" class="button button-outline" data-remove-line>Remove</button></div>`; }

  function openDialog(nextAction, id = '') {
    if (saving) return;
    if (nextAction === 'order' && !parkedOrder) pendingCustomerDetails = null;
    if (nextAction === 'customer') pendingCustomerId = id || crypto.randomUUID();
    action = nextAction; targetId = id; $('order-form-error').hidden = true;
    $('order-dialog-save').hidden = nextAction === 'viewOrder';
    $('order-dialog-save').textContent = nextAction === 'deleteCustomer' ? 'Delete customer' : 'Save';
    const c = customers.find((row) => row.id === id), o = orders.find((row) => row.id === id), s = specials.find((row) => row.id === id);
    $('order-dialog-title').textContent = ({ customer: c ? 'Edit customer' : 'Add customer', order: o ? `Edit ${o.orderNumber}` : 'New order', viewOrder: `Order ${o?.orderNumber || ''}`, special: s ? 'Edit combination' : 'Add combination', cancel: 'Cancel order', archive: 'Archive order', restore: 'Restore order', request: 'Record payment request', intake: 'Order-taking', invoice: 'Create invoice' })[nextAction];
    if (nextAction === 'viewOrder' && o) $('order-fields').innerHTML = `<div class="ops-lines"><p><strong>Customer:</strong> ${esc(o.customerSnapshot?.fullName)}</p><p><strong>Assigned to:</strong> ${esc(assignedUserName(o))}</p><p><strong>Status:</strong> ${esc(o.status)}</p><p><strong>Order date:</strong> ${esc(o.orderDate)}</p><p><strong>Order lines</strong></p>${(o.lines || []).map((line) => `<p>${esc(line.kind === 'special' ? line.specialSnapshot?.name : line.itemSnapshot?.name)} · ${esc(qtyText(line.quantityQty))} ${esc(line.kind === 'special' ? 'combo' : orderLineUnitLabel(line))} · ${rupees(line.lineTotalPaise)}</p>`).join('')}<p><strong>Total:</strong> ${rupees(o.grandTotal)}</p>${o.notes ? `<p><strong>Notes:</strong> ${esc(o.notes)}</p>` : ''}</div>`;
    if (nextAction === 'customer') $('order-fields').innerHTML = customerFields(c || (parkedOrder ? pendingCustomerDetails || {} : {}));
    if (nextAction === 'deleteCustomer') {
      if (!staff() || !c) return;
      $('order-dialog-title').textContent = 'Delete customer';
      $('order-fields').innerHTML = `<p>Permanently delete <strong>${esc(c.fullName)}</strong>?</p><p>This is allowed only if no transaction records have ever been linked to this customer. This action cannot be undone.</p>`;
    }
    if (nextAction === 'order') {
      const selectedCustomer = o?.customerId || '__new__';
      $('order-fields').innerHTML = `<div class="order-customer-choice"><label class="ops-field">Customer<select name="customerId" id="order-customer" ${o ? 'disabled' : ''}><option value="__new__" ${selectedCustomer === '__new__' ? 'selected' : ''}>+ Add New Customer</option>${customers.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)).map((row) => `<option value="${esc(row.id)}" ${row.id === selectedCustomer ? 'selected' : ''}>${esc(row.fullName)} · ${esc(row.contact)}</option>`).join('')}</select></label><button id="order-add-customer" class="ops-link" type="button" ${o ? 'hidden' : ''}>${pendingCustomerDetails ? 'Edit new customer details' : 'Enter new customer details'}</button></div>${o ? `<input type="hidden" name="customerId" value="${esc(o.customerId)}">` : ''}${admin() ? `<label class="ops-field">Assigned User<select name="assignedUserId" required ${o ? 'disabled' : ''}>${eligibleUsers().map((row) => `<option value="${esc(row.id)}" ${o?.assignedUserId === row.id ? 'selected' : ''}>${esc(row.displayName || row.fullName || row.id)}</option>`).join('')}</select></label>` : ''}${field('Order date', 'orderDate', 'date', o?.orderDate || new Date().toISOString().slice(0, 10), 'required')}${field('Delivery date (optional)', 'deliveryDate', 'date', o?.deliveryDate || '')}<div class="ops-lines order-entry-lines"><h3>Order Lines</h3><p id="order-stock-message" class="muted"></p><div id="order-lines">${(o?.lines || [{}]).map(orderLine).join('')}</div><button id="order-add-line" class="button button-outline" type="button">+ Add Line</button><p class="muted">Prices are checked again when the order is confirmed.${admin() ? ' Special products use whole combos.' : ''}</p></div><label class="ops-field">Notes<textarea name="notes" maxlength="1000">${esc(o?.notes || '')}</textarea></label>`;
      toggleNewCustomer();
      refreshStock();
    }
    if (nextAction === 'special') $('order-fields').innerHTML = `${field('Name', 'name', 'text', s?.name, 'required maxlength="120"')}${field('Final selling price (₹)', 'price', 'number', s ? s.finalPricePaise / 100 : '', 'min="0" step="0.01" required')}<label class="ops-field">Description<textarea name="description" maxlength="500">${esc(s?.description || '')}</textarea></label><label class="ops-field">Status<select name="active"><option value="true" ${s?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${s?.active === false ? 'selected' : ''}>Inactive</option></select></label><div class="ops-lines"><strong>Recipe: 2 to 4 distinct items</strong><div id="special-components">${(s?.components || [{}, {}]).map(componentLine).join('')}</div><button id="special-add-component" class="button button-outline" type="button">Add component</button></div>`;
    if (nextAction === 'archive') $('order-fields').innerHTML = `<p>Archive ${esc(o?.orderNumber)}? The order and its financial history remain available. Stock is not restored by archiving.</p>${field('Reason (optional)', 'reason', 'text', '', 'maxlength="500"')}`;
    if (nextAction === 'restore') $('order-fields').innerHTML = `<p>Restore ${esc(o?.orderNumber)} to active orders?</p>`;
    if (nextAction === 'request') $('order-fields').innerHTML = `<p>Record that payment was requested for ${esc(o?.orderNumber)}? This locks editing and archiving. It does not send a message or submit a payment.</p>`;
    if (nextAction === 'cancel') $('order-fields').innerHTML = `<p>Cancel ${esc(o?.orderNumber)}? Stock will be restored for a confirmed, undelivered order. Invoiced orders need a separate return workflow.</p>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'intake') $('order-fields').innerHTML = `<p>Order-taking is currently ${acceptingOrders ? 'open' : 'paused'}.</p><label class="ops-field">New status<select name="acceptingOrders"><option value="false">Pause</option><option value="true">Resume</option></select></label>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'invoice') $('order-fields').innerHTML = `<p>Create one invoice from ${esc(o?.orderNumber)}? The invoice will contain the confirmed customer and price snapshots. Sabha is excluded.</p>`;
    if (!$('order-dialog').open) $('order-dialog').showModal();
  }
  function customerOptions(selected = '__new__') {
    return `<option value="__new__" ${selected === '__new__' ? 'selected' : ''}>+ Add New Customer</option>${customers.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)).map((row) => `<option value="${esc(row.id)}" ${row.id === selected ? 'selected' : ''}>${esc(row.fullName)} · ${esc(row.contact)}</option>`).join('')}`;
  }
  function toggleNewCustomer() {
    const button = $('order-add-customer'), select = $('order-customer'); if (!button || !select) return;
    button.hidden = select.disabled || select.value !== '__new__';
    button.textContent = pendingCustomerDetails ? `Edit new customer details: ${pendingCustomerDetails.fullName}` : 'Enter new customer details';
  }
  function openCustomerFromOrder() {
    if (saving || action !== 'order' || parkedOrder || !$('order-customer') || $('order-customer').disabled) return;
    const fields = $('order-fields'), fragment = document.createDocumentFragment();
    while (fields.firstChild) fragment.appendChild(fields.firstChild);
    parkedOrder = { fragment, targetId, title: $('order-dialog-title').textContent };
    openDialog('customer');
  }
  function restoreOrderForm(customerId = null) {
    if (!parkedOrder) return;
    const previous = parkedOrder;
    parkedOrder = null;
    const fields = $('order-fields'); fields.innerHTML = ''; fields.appendChild(previous.fragment);
    action = 'order'; targetId = previous.targetId;
    $('order-dialog-title').textContent = previous.title;
    $('order-dialog-save').textContent = 'Save';
    $('order-form-error').hidden = true;
    const select = $('order-customer');
    if (select && customerId) { select.innerHTML = customerOptions(customerId); select.value = customerId; }
    toggleNewCustomer();
    updateStockLabels();
  }
  function closeOrderDialog() {
    if (parkedOrder) restoreOrderForm();
    else $('order-dialog').close();
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || action === 'viewOrder') return;
    saving = true;
    const data = new FormData(event.currentTarget), button = $('order-dialog-save');
    button.disabled = true; $('order-form-error').hidden = true;
    try {
      let name, payload;
      if (action === 'deleteCustomer') { if (!staff()) throw new Error('Staff access is required.'); name = 'deleteCustomer'; payload = { customerId: targetId }; } else if (action === 'customer') {
        if (!staff() && !parkedOrder) throw new Error('Staff access is required.');
        payload = validateCustomerInput(readCustomerFields(data));
        const duplicate = customers.find((c) => c.id !== targetId && normalize(c.contact) === normalize(payload.contact));
        if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}.`);
        if (parkedOrder) {
          if (staff()) {
            const saved = await saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: true });
            if (!customers.some((row) => row.id === saved.customerId)) customers.push({ id: saved.customerId, ...payload });
            pendingCustomerDetails = null;
            restoreOrderForm(saved.customerId);
            showToast('Customer created and selected.');
          } else {
            pendingCustomerDetails = payload;
            restoreOrderForm();
            showToast('Customer details will be saved with the order.');
          }
          return;
        }
      } else if (action === 'special') {
        if (!staff()) throw new Error('Staff access is required.');
        payload = { specialId: targetId || undefined, name: data.get('name'), description: data.get('description'), finalPricePaise: toPaise(data.get('price')), active: data.get('active') === 'true', components: [...$('special-components').children].map((row) => { const itemId = row.querySelector('[name=itemId]').value; return { itemId, unitId: items.find((item) => item.id === itemId)?.defaultUnitId, quantityQty: toMilli(row.querySelector('[name=quantity]').value) }; }) };
        name = 'saveSpecialProduct';
      } else if (action === 'order') {
        const selected = data.get('customerId');
        if (selected === '__new__' && !pendingCustomerDetails) throw new Error('Enter new customer details before saving the order.');
        payload = { orderId: targetId || pendingOrderId || crypto.randomUUID(), customerId: selected === '__new__' ? undefined : selected, newCustomer: selected === '__new__' ? pendingCustomerDetails : undefined, ...(admin() && !targetId ? { assignedUserId: data.get('assignedUserId') } : {}), orderDate: data.get('orderDate'), deliveryDate: data.get('deliveryDate') || null, notes: data.get('notes'), lines: [...$('order-lines').children].map((row) => { const kind = row.querySelector('[name=kind]').value, unitId = row.querySelector('[name=unitId]')?.value; return { kind, productId: row.querySelector('[name=productId]').value, quantityQty: toMilli(row.querySelector('[name=quantity]').value), ...(kind === 'item' && unitId && unitId !== '__legacy__' ? { unitId } : {}) }; }) };
        if (!admin() && payload.lines.some((line) => line.kind === 'special')) throw new Error('Only Admin may create or edit a special order.');
        if (selected === '__new__') {
          const duplicate = customers.find((c) => normalize(c.contact) === normalize(payload.newCustomer.contact));
          if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}. Select that customer.`);
        }
        await refreshStock();
        const warning = stockWarning(payload.lines, orders.find((row) => row.id === targetId));
        if (warning && targetId && orders.find((row) => row.id === targetId)?.status !== 'draft') throw new Error(warning);
        if (warning) showToast(warning, 'toast-error');
        pendingOrderId = payload.orderId; name = 'saveOrderDraft';
      } else if (action === 'archive') { name = 'archiveOrder'; payload = { orderId: targetId, reason: data.get('reason') || '' }; }
      else if (action === 'restore') { name = 'restoreOrder'; payload = { orderId: targetId }; }
      else if (action === 'request') { name = 'requestOrderPayment'; payload = { orderId: targetId }; }
      else if (action === 'cancel') { name = 'cancelOrder'; payload = { orderId: targetId, reason: data.get('reason') }; }
      else if (action === 'intake') { name = 'setOrderTaking'; payload = { acceptingOrders: data.get('acceptingOrders') === 'true', reason: data.get('reason') }; }
      else { name = 'createInvoiceFromOrder'; payload = { orderId: targetId }; }
      if (action === 'customer') await saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: !targetId });
      else await callOperation(functions, name, payload);
      pendingOrderId = ''; $('order-dialog').close(); showToast(action === 'deleteCustomer' ? 'Customer deleted.' : action === 'invoice' ? 'Invoice created. Record payment from the Invoices page.' : 'Saved successfully.');
      await refresh(['customer', 'deleteCustomer'].includes(action) ? 'customers' : action === 'special' ? 'specials' : 'orders');
      if (action === 'invoice') viewInvoice(orders.find((row) => row.id === targetId)?.orderNumber);
    } catch (error) { $('order-form-error').textContent = action === 'customer' ? customerSaveError(error) : cleanError(error); $('order-form-error').hidden = false; }
    finally { saving = false; button.disabled = false; }
  }

  async function runOrderAction(nextAction, id) {
    const o = orders.find((row) => row.id === id); if (!o) return;
    if (nextAction === 'viewOrder') return openDialog('viewOrder', id);
    if (nextAction === 'editOrder') return openDialog('order', id);
    if (nextAction === 'cancelOrder') return openDialog('cancel', id);
    if (nextAction === 'archiveOrder') return openDialog('archive', id);
    if (nextAction === 'restoreOrder') return openDialog('restore', id);
    if (nextAction === 'requestPayment') return openDialog('request', id);
    if (nextAction === 'invoiceOrder') return openDialog('invoice', id);
    if (nextAction === 'viewInvoice') return viewInvoice(o.orderNumber);
    try {
      if (nextAction === 'confirmOrder') await callOperation(functions, 'confirmOrder', { orderId: id });
      if (nextAction === 'advanceOrder') {
        const transitions = { confirmed: 'in_preparation', in_preparation: 'ready', ready: 'delivered' };
        await callOperation(functions, 'advanceOrder', { orderId: id, nextStatus: transitions[o.status] });
      }
      showToast(nextAction === 'confirmOrder' ? staff() ? 'Order confirmed. Select Create invoice on this order to continue.' : 'Order confirmed. An Admin or Account Admin must create the invoice before payment can be recorded.' : 'Order updated.'); await refresh('orders');
    } catch (error) { showToast(cleanError(error), 'toast-error'); }
  }

  const activityFilters = () => ({
    actor: $('order-activity-actor').value.trim(), customer: $('order-activity-customer').value.trim(),
    order: $('order-activity-order').value.trim(), invoice: $('order-activity-invoice').value.trim(), payment: $('order-activity-payment').value.trim(), type: $('order-activity-type').value,
    from: $('order-activity-from').value, to: $('order-activity-to').value,
  });
  function activityChanges(row) {
    const fields = Object.entries(row.changedFields || {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('; ');
    return [fields, row.reason ? `Reason: ${row.reason}` : ''].filter(Boolean).join('; ');
  }
  function renderActivity() {
    $('order-activity-page').textContent = `Page ${activityPage}${activityHasMore ? ' · more available' : ''}`;
    $('order-activity-prev').disabled = activityPage === 1;
    $('order-activity-next').disabled = !activityHasMore;
    $('order-activity-body').innerHTML = activityRows.length ? activityRows.map((row) => `<tr><td>${esc(row.at ? new Date(row.at).toLocaleString('en-IN') : '')}</td><td>${esc(row.type?.replace(/^order\./, '').replaceAll('_', ' '))}</td><td>${esc(row.orderNumber)}</td><td>${esc(row.actorName)}</td><td>${esc(row.customerName)}</td><td>${esc(activityChanges(row))}</td><td>${esc(row.outcome || 'success')}</td></tr>`).join('') : empty(7, 'No order actions match these filters.');
  }
  async function loadActivity(reset = false) {
    if (!profile) return;
    const revision = ++activityRevision;
    if (reset) { activityPage = 1; activityCursors = [null]; }
    $('order-activity-message').textContent = 'Loading order activity…';
    try {
      const result = await callOperation(functions, 'listOrderActivity', { filters: activityFilters(), cursor: activityCursors[activityPage - 1] });
      if (revision !== activityRevision) return;
      activityRows = result?.rows || []; activityNext = result?.cursor || null; activityHasMore = result?.hasMore === true;
      renderActivity(); $('order-activity-message').textContent = '';
    } catch (error) { if (revision === activityRevision) { activityRows = []; activityHasMore = false; renderActivity(); $('order-activity-message').textContent = `Could not load activity: ${cleanError(error)}`; } }
  }
  async function exportActivity() {
    $('order-activity-export').disabled = true;
    try {
      const rows = [], seen = new Set(); let cursor = null;
      do {
        const result = await callOperation(functions, 'listOrderActivity', { filters: activityFilters(), cursor });
        rows.push(...result.rows);
        if (!result.hasMore) break;
        if (!result.cursor || seen.has(result.cursor)) throw new Error('Activity export could not complete.');
        cursor = result.cursor; seen.add(cursor);
      } while (true);
      if (!rows.length) return showToast('No activity matches these filters.', 'toast-error');
      await downloadXlsx('order-activity', [['Order Activity', rows.map((row) => ({ When: row.at ? new Date(row.at).toLocaleString('en-IN') : '', Action: row.type, Order: row.orderNumber, Actor: row.actorName, Customer: row.customerName, Changes: activityChanges(row), Reason: row.reason || '', Outcome: row.outcome }))]]);
    } catch (error) { showToast(cleanError(error), 'toast-error'); }
    finally { $('order-activity-export').disabled = false; }
  }

  document.addEventListener('oms:pagechange', (event) => { if (['customers', 'orders', 'specials'].includes(event.detail.page) && profile) refresh(event.detail.page); });
  $('customer-new').addEventListener('click', () => openDialog('customer'));
  $('order-new').addEventListener('click', () => { pendingOrderId = ''; openDialog('order'); });
  $('special-new').addEventListener('click', () => openDialog('special'));
  $('order-intake').addEventListener('click', () => openDialog('intake'));
  $('order-activity-apply').addEventListener('click', () => loadActivity(true));
  $('order-activity-export').addEventListener('click', exportActivity);
  $('order-activity-prev').addEventListener('click', () => { if (activityPage > 1) { activityPage--; loadActivity(); } });
  $('order-activity-next').addEventListener('click', () => { if (activityHasMore && activityNext) { activityCursors[activityPage] = activityNext; activityPage++; loadActivity(); } });
  ['customers', 'orders', 'specials'].forEach((page) => $(page === 'specials' ? 'special-refresh' : page.slice(0, -1) + '-refresh').addEventListener('click', () => refresh(page)));
  ['customer-search'].forEach((id) => $(id).addEventListener('input', renderCustomers));
  ['order-search', 'order-status', 'order-archive', 'order-user', 'order-from', 'order-to'].forEach((id) => $(id).addEventListener('input', renderOrders));
  ['special-search', 'special-status'].forEach((id) => $(id).addEventListener('input', renderSpecials));
  $('customer-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog(button.dataset.action === 'deleteCustomer' ? 'deleteCustomer' : 'customer', button.dataset.id); });
  $('special-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog('special', button.dataset.id); });
  $('order-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) runOrderAction(button.dataset.action, button.dataset.id); });
  $('order-fields').addEventListener('change', (event) => {
    if (event.target.id === 'order-customer') { toggleNewCustomer(); if (event.target.value === '__new__') openCustomerFromOrder(); }
    if (event.target.name === 'productId') refreshStock();
    if (event.target.name === 'unitId') updateStockLabels();
    if (event.target.name === 'kind') { const row = event.target.closest('.ops-line'); row.querySelector('[name=productId]').innerHTML = productOptions(event.target.value); const unit = row.querySelector('.order-line-unit'); if (unit) { unit.hidden = event.target.value !== 'item'; unit.querySelector('select').disabled = event.target.value !== 'item'; } refreshStock(); }
  });
  $('order-fields').addEventListener('click', (event) => {
    if (event.target.id === 'order-add-customer') openCustomerFromOrder();
    if (event.target.id === 'order-add-line') { $('order-lines').insertAdjacentHTML('beforeend', orderLine()); updateStockLabels(); }
    if (event.target.id === 'special-add-component' && $('special-components').children.length < 4) $('special-components').insertAdjacentHTML('beforeend', componentLine());
    if (event.target.matches('[data-remove-line]')) { const holder = event.target.closest('.ops-lines').querySelector('div[id]'); if (holder.children.length > (action === 'special' ? 2 : 1)) event.target.closest('.ops-line').remove(); }
  });
  $('order-form').addEventListener('submit', submit);
  $('order-dialog-close').addEventListener('click', closeOrderDialog);
  $('order-dialog-cancel').addEventListener('click', closeOrderDialog);
  $('order-dialog').addEventListener('cancel', (event) => { if (parkedOrder) { event.preventDefault(); restoreOrderForm(); } });
  $('customer-export').addEventListener('click', () => exportBook('customers', [['Customers', filteredCustomers().map((c) => ({ Name: c.fullName, Contact: c.contact, Address: c.address, Area: c.area, ...(staff() ? { DateOfBirth: c.dateOfBirth, Sabha: c.sabha } : {}) }))]]));
  $('order-export').addEventListener('click', () => { const rows = filteredOrders(); exportBook('orders', [['Orders', rows.map((o) => ({ OrderNumber: o.orderNumber, Customer: o.customerSnapshot?.fullName, Date: o.orderDate, DeliveryDate: o.deliveryDate, AssignedUser: assignedUserName(o), Status: o.status, TotalRupees: (o.grandTotal || 0) / 100 }))], ['Lines', rows.flatMap((o) => o.lines?.map((l) => ({ OrderNumber: o.orderNumber, Product: l.kind === 'item' ? l.itemSnapshot?.name : l.specialSnapshot?.name, Quantity: l.quantityQty / 1000, Unit: l.kind === 'item' ? orderLineUnitLabel(l) : 'combo', UnitPriceRupees: l.unitPricePaise / 100, LineTotalRupees: l.lineTotalPaise / 100 })) || [])]]); });
  $('special-export').addEventListener('click', () => exportBook('specials', [['Special Products', filteredSpecials().map((s) => ({ Name: s.name, FinalPriceRupees: s.finalPricePaise / 100, Active: s.active, Components: s.components?.map((p) => `${p.itemSnapshot?.name}: ${qtyText(p.quantityQty)} ${p.itemSnapshot?.unitSymbol}`).join('; ') }))]]));

  return { setSession(nextUser, nextProfile) { sessionVersion++; activityRevision++; user = nextUser; profile = nextProfile; orders = []; customers = []; items = []; specials = []; users = []; invoiceIds = new Set(); stockAvailability = new Map(); stockMessage = ''; activityRows = []; activityCursors = [null]; activityPage = 1; pendingOrderId = ''; pendingCustomerId = ''; pendingCustomerDetails = null; parkedOrder = null; ['customer-body', 'order-body', 'special-body', 'customer-summary', 'order-cards', 'order-activity-body'].forEach((id) => { $(id).innerHTML = ''; }); $('order-user').value = ''; $('order-user').hidden = !admin(); if (profile) { const page = document.querySelector('[data-page].is-active')?.dataset.page; if (['customers', 'orders', 'specials'].includes(page)) refresh(page); } } };
}
