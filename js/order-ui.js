import { hasPermission, isStaff, validateProfile } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { getOrderTaking, listCustomers, listOrderProducts, listOrders } from './order-data.js';
import { listMasterRecords } from './master-data.js';
import { downloadXlsx } from './xlsx-export.js';
import { saveCustomerDirect } from './customer-data.js';
import { customerSaveError, validateCustomerInput } from './customer-validation.js';
import { listInvoices } from './finance-data.js';
import { availableOrderUnits, itemUnitPrice, orderLineUnitLabel } from './order-units.js';
import { actionLabel, activityDate, changeSummary, references } from './activity-format.js';
import { listActivity } from './activity-data.js';
import { uniqueId } from './unique-id.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const rupees = (paise) => inr.format((paise || 0) / 100);
const amountValue = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const qtyText = (milli) => ((milli || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const empty = (count, label) => `<tr><td colspan="${count}" class="empty-cell">${esc(label)}</td></tr>`;
const cleanError = (error) => error?.message?.replace(/^.*?: /, '') || 'Operation failed. Try again.';
const field = (label, name, type = 'text', value = '', attrs = '') => `<label class="ops-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\s()-]/g, '');
const productImageByName = new Map([
  ['dryfruitbar', './logo/dryfruit bar.png'], ['anjirroll', './logo/anjir roll.png'], ['kesarkajukatri', './logo/kesar kaju katri.png'],
  ['anjircake', './logo/anjir cake.png'], ['kajukatri', './logo/kaju katri.png'], ['mohanthal', './logo/mohanthal.png'],
]);
const productImage = (name) => {
  const path = productImageByName.get(normalize(name).replace(/[^a-z0-9]/g, ''));
  return path ? encodeURI(path) : '';
};
const displayOrderStatus = (status) => status === 'confirmed' ? 'Confirmed' : status;
const orderStatusBadge = (status, archived = false) => {
  const label = archived ? `${displayOrderStatus(status)} Â· Archived` : displayOrderStatus(status);
  const tone = archived ? 'archived' : String(status || 'unknown').replace(/_/g, '-');
  return `<span class="order-status-badge is-${esc(tone)}">${esc(label)}</span>`;
};
const toMilli = (value) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) throw new Error('Use up to three decimal places for quantity.'); return Math.round(n * 1000); };
const toOrderQuantity = (value) => { const text = String(value).trim(); if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text) * 1000)) throw new Error('Enter a whole-number quantity of at least 1.'); return Number(text) * 1000; };
const toPaise = (value) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-7) throw new Error('Use up to two decimal places for price.'); return Math.round(n * 100); };

async function exportBook(name, sheets) {
  try {
    await downloadXlsx(name, sheets);
  } catch { showToast('XLSX export could not load. Check your connection.', 'toast-error'); }
}

export function initOrderUi({ db, functions, auth, mode }) {
  $('order-activity-type').insertAdjacentHTML?.('beforeend', '<option value="order.locked">Editing locked</option>');
  $('order-activity-type').insertAdjacentHTML?.('beforeend', '<option value="order.stock_deducted">Stock deducted</option>');
  $('order-activity-order').insertAdjacentHTML?.('afterend', '<input id="order-activity-invoice" type="search" placeholder="Invoice ID" aria-label="Activity invoice"><input id="order-activity-payment" type="search" placeholder="Payment ID" aria-label="Activity payment">');
  let user = null, profile = null, orders = [], customers = [], items = [], specials = [], users = [], acceptingOrders = true, orderStep = 1, productCategory = '';
  const mobileNavigation = $('mobile-navigation');
  const mobileNavigationParent = mobileNavigation?.parentNode;
  const mobileNavigationNext = mobileNavigation?.nextSibling;
  let invoiceIds = new Set(), stockAvailability = new Map(), stockMessage = '';
  let activityPage = 1, activityCursors = [null], activityRows = [], activityNext = null, activityHasMore = false, activityRevision = 0;
  let activityLoadToken = null;
  const stopActivityLoad = () => { if (activityLoadToken) globalThis.omsLoading?.stop(activityLoadToken); activityLoadToken = null; };
  let action = '', targetId = '', pendingOrderId = '', pendingCustomerId = '', pendingCustomerDetails = null, parkedOrder = null, saving = false;
  const pendingOrderActions = new Set();
  let sessionVersion = 0;
  let ordersLoaded = false, orderRefreshPromise = null, orderInitialToken = null;
  const blankOrderFilters = () => ({ search: '', user: '', status: '', archive: '', from: '', to: '' });
  let appliedOrderFilters = blankOrderFilters();
  const orderFilterIds = { search: 'order-search', user: 'order-user', status: 'order-status', archive: 'order-archive', from: 'order-from', to: 'order-to' };
  const readOrderFilters = () => Object.fromEntries(Object.entries(orderFilterIds).map(([key, id]) => [key, $(id).value.trim()]));
  const writeOrderFilters = (filters) => { for (const [key, id] of Object.entries(orderFilterIds)) $(id).value = filters[key] || ''; };
  const recordLoadTokens = new Map(), recordLoadRuns = new Map();
  const stopRecordLoad = (page) => { const token = recordLoadTokens.get(page); if (token) globalThis.omsLoading?.stop(token); recordLoadTokens.delete(page); };
  const stopOrderInitialLoader = () => {
    if (orderInitialToken) globalThis.omsLoading?.stop(orderInitialToken);
    orderInitialToken = null;
  };
  const activeOrdersPage = () => document.querySelector('[data-page].is-active')?.dataset.page === 'orders';
  let orderViewportBaseHeight = 0, orderViewportListening = false;
  const orderVisualViewport = globalThis.visualViewport;
  function syncOrderViewport() {
    const dialog = $('order-dialog');
    if (!dialog?.open || !dialog.classList?.contains?.('order-create-mode')) return;
    const height = Math.round(orderVisualViewport?.height || globalThis.innerHeight || 0);
    if (!height) return;
    const focused = document.activeElement;
    const typing = dialog.contains?.(focused) && focused?.matches?.('input:not([type="hidden"]), textarea');
    if (!typing && !dialog.classList.contains('order-keyboard-open') && height >= orderViewportBaseHeight - 120) orderViewportBaseHeight = height;
    const keyboardOpen = height < orderViewportBaseHeight - 120 && (typing || dialog.classList.contains('order-keyboard-open'));
    dialog.classList.toggle('order-keyboard-open', Boolean(keyboardOpen));
    if (keyboardOpen) {
      dialog.style?.setProperty?.('--order-visible-height', `${height}px`);
      if (typing) globalThis.requestAnimationFrame?.(() => focused.scrollIntoView?.({ block: 'nearest' }));
    } else {
      dialog.style?.removeProperty?.('--order-visible-height');
      if (!typing) orderViewportBaseHeight = height;
    }
  }
  function startOrderViewport() {
    if (orderViewportListening) return;
    orderViewportListening = true;
    const height = Math.round(orderVisualViewport?.height || globalThis.innerHeight || 0);
    if (height < orderViewportBaseHeight - 120) $('order-dialog').classList?.add?.('order-keyboard-open');
    orderViewportBaseHeight = Math.max(orderViewportBaseHeight, height);
    orderVisualViewport?.addEventListener?.('resize', syncOrderViewport);
    globalThis.addEventListener?.('resize', syncOrderViewport);
    document.addEventListener?.('focusin', syncOrderViewport, true);
    document.addEventListener?.('focusout', syncOrderViewport, true);
    syncOrderViewport();
  }
  function stopOrderViewport(resetBase = false) {
    if (!orderViewportListening) { if (resetBase) orderViewportBaseHeight = 0; return; }
    orderViewportListening = false;
    orderVisualViewport?.removeEventListener?.('resize', syncOrderViewport);
    globalThis.removeEventListener?.('resize', syncOrderViewport);
    document.removeEventListener?.('focusin', syncOrderViewport, true);
    document.removeEventListener?.('focusout', syncOrderViewport, true);
    $('order-dialog').classList?.remove?.('order-keyboard-open');
    $('order-dialog').style?.removeProperty?.('--order-visible-height');
    if (resetBase) orderViewportBaseHeight = 0;
  }
  const staff = () => isStaff(profile);
  const admin = () => !validateProfile(profile) && profile.role === 'admin';
  // Special orders were administered by Admin before the temporary role change.
  const special = () => admin();
  const eligibleUsers = () => [...new Map(users.filter(row => row.id && !validateProfile(row)).map(row => [row.id, row])).values()];
  const orderAssignees = () => [...new Map([...(user && profile && !validateProfile(profile) ? [{ ...profile, id: user.uid }] : []), ...eligibleUsers()].map((row) => [row.id, row])).values()];
  // Staff can see all customers, but assigning one to any active OMS account keeps
  // the selected account visible in customer and order ownership records.
  const customerAssignees = () => eligibleUsers();
  const customerAssigneeName = (customer) => customer.assignedUserId ? users.find((row) => row.id === customer.assignedUserId)?.displayName || users.find((row) => row.id === customer.assignedUserId)?.fullName || (customer.assignedUserId === user?.uid ? 'You' : 'Assigned user') : 'Unassigned';
  const assignedUserName = (order) => {
    const uid = order.assignedUserId || order.ownerUid;
    const record = users.find((entry) => entry.id === uid);
    return record?.displayName || record?.fullName
      || (uid === user?.uid ? profile?.displayName || profile?.fullName : '')
      || order.assignedUserName || 'Unknown user';
  };

  async function refreshPage(page) {
    if (!profile) return;
    const version = sessionVersion, run = (recordLoadRuns.get(page) || 0) + 1;
    recordLoadRuns.set(page, run);
    const current = () => version === sessionVersion && run === recordLoadRuns.get(page);
    const message = $(`${page === 'specials' ? 'special' : page === 'orders' ? 'order' : 'customer'}-message`);
    message.textContent = '';
    if (page !== 'orders') {
      stopRecordLoad(page);
      recordLoadTokens.set(page, globalThis.omsLoading?.start(page === 'customers' ? 'Loading customers…' : 'Loading special products…') || null);
    }
    if (page === 'orders') { $('order-loading').hidden = false; $('order-table-scroll').hidden = true; $('order-export').disabled = true; $('order-retry').hidden = true; }
    try {
      const privileged = staff();
      const scopedUid = privileged ? null : user.uid;
      if (page === 'customers') {
        const [rows, userRows] = await Promise.all([listCustomers(db, scopedUid), admin() ? listMasterRecords(db, 'users') : Promise.resolve([])]);
        if (!current()) return;
        customers = rows; if (admin()) users = userRows;
        renderCustomers();
      } else if (page === 'orders') {
        const scopedOrders = await listOrders(db, scopedUid);
        const [customerRows, itemRows, specialRows, control, userRows, invoiceRows] = await Promise.all([
          listCustomers(db, scopedUid, scopedOrders), listOrderProducts(db, 'items', privileged), listOrderProducts(db, 'specialProducts', privileged), getOrderTaking(db), privileged ? listMasterRecords(db, 'users') : Promise.resolve([]), listInvoices(db, scopedUid),
        ]);
        if (!current()) return;
        orders = scopedOrders; customers = customerRows; items = itemRows; specials = specialRows; acceptingOrders = control; users = userRows;
        invoiceIds = new Set(invoiceRows.map((invoice) => invoice.orderId));
        await refreshStock();
        if (!current()) return;
        renderOrders();
        ordersLoaded = true;
        $('order-table-scroll').hidden = false;
        $('order-export').disabled = false;
        loadActivity(true);
      } else if (page === 'specials' && staff()) {
        const [itemRows, specialRows] = await Promise.all([listOrderProducts(db, 'items', true), listOrderProducts(db, 'specialProducts', true)]);
        if (!current()) return;
        items = itemRows; specials = specialRows;
        renderSpecials();
      }
      if (current()) message.textContent = '';
    } catch (error) { if (current()) { console.error('Could not load orders:', error); if (page === 'orders') { ordersLoaded = false; orders = []; $('order-body').innerHTML = ''; $('order-mobile-list').innerHTML = ''; $('order-cards').innerHTML = ''; $('order-table-scroll').hidden = false; $('order-body').innerHTML = empty(7, 'Orders could not be loaded. Please retry.'); $('order-retry').hidden = false; } message.textContent = `Could not load records: ${cleanError(error)}`; } }
    finally { if (page === 'orders' && current()) $('order-loading').hidden = true; if (page !== 'orders' && current()) stopRecordLoad(page); }
  }

  function refresh(page, opening = false) {
    if (page !== 'orders') return refreshPage(page);
    if (opening && !ordersLoaded && !orderInitialToken && activeOrdersPage()) orderInitialToken = globalThis.omsLoading?.start('Loading orders…') || null;
    if (orderRefreshPromise) {
      if (opening && activeOrdersPage()) $('order-loading').hidden = false;
      return opening ? orderRefreshPromise : orderRefreshPromise.then(() => refresh(page));
    }
    const request = refreshPage(page);
    orderRefreshPromise = request;
    request.finally(() => {
      if (orderRefreshPromise === request) { orderRefreshPromise = null; stopOrderInitialLoader(); }
    });
    return request;
  }

  const filteredCustomers = () => customers.filter((customer) => `${customer.fullName} ${customer.contact} ${customer.area}`.toLowerCase().includes($('customer-search').value.toLowerCase())).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const filteredOrders = () => orders.filter((order) => {
    const filters = appliedOrderFilters;
    const search = filters.search.toLocaleLowerCase();
    return (!search || `${order.orderNumber || ''} ${order.customerSnapshot?.fullName || ''} ${order.customerSnapshot?.contact || ''} ${assignedUserName(order)}`.toLocaleLowerCase().includes(search))
      && (!filters.status || order.status === filters.status)
      && (!filters.archive || (order.archivedAt ? 'archived' : 'active') === filters.archive)
      && (!staff() || !filters.user || (order.assignedUserId || order.ownerUid) === filters.user)
      && (!filters.from || order.orderDate >= filters.from)
      && (!filters.to || order.orderDate <= filters.to);
  }).sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.orderNumber.localeCompare(a.orderNumber));
  function renderOrderFilterChips() {
    const filters = appliedOrderFilters;
    const userName = users.find((row) => row.id === filters.user);
    const labels = [
      ['search', filters.search && `Search: ${filters.search}`],
      ['user', staff() && filters.user && `User: ${userName?.displayName || userName?.fullName || filters.user}`],
      ['status', filters.status && `Status: ${$('order-status').querySelector?.(`option[value="${filters.status}"]`)?.textContent || displayOrderStatus(filters.status)}`],
      ['archive', filters.archive && `Archive: ${filters.archive === 'active' ? 'Active' : 'Archived'}`],
      ['dates', (filters.from || filters.to) && `Date: ${filters.from || 'Any'} – ${filters.to || 'Any'}`],
    ].filter(([, label]) => label);
    $('order-active-filters').hidden = !labels.length;
    $('order-active-filters').innerHTML = labels.map(([key, label]) => `<button type="button" class="order-filter-chip" data-filter="${key}" aria-label="Remove ${esc(label)} filter">${esc(label)} <span aria-hidden="true">×</span></button>`).join('');
  }
  function applyOrderFilters(filters = readOrderFilters()) {
    if (filters.from && filters.to && filters.from > filters.to) {
      $('order-message').textContent = 'From Date must be on or before To Date.';
      return;
    }
    appliedOrderFilters = { ...blankOrderFilters(), ...filters, user: staff() ? filters.user : '' };
    writeOrderFilters(appliedOrderFilters);
    $('order-filter-pending').hidden = true;
    $('order-message').textContent = '';
    renderOrders();
  }
  const filteredSpecials = () => specials.filter((special) => {
    const search = $('special-search').value.toLowerCase();
    const status = $('special-status').value;
    return (!search || `${special.name} ${special.components?.map((p) => p.itemSnapshot?.name).join(' ')}`.toLowerCase().includes(search)) && (!status || special.active === (status === 'active'));
  }).sort((a, b) => a.name.localeCompare(b.name));

  function renderCustomers() {
    $('customer-new').hidden = !staff();
    const rows = filteredCustomers();
    $('customer-summary').innerHTML = `<div class="card ops-stat"><span>Visible customers</span><strong>${rows.length}</strong></div>${staff() ? `<div class="card ops-stat"><span>Sabha customers</span><strong>${rows.filter((c) => c.sabha).length}</strong></div><div class="card ops-stat"><span>Areas</span><strong>${new Set(rows.map((c) => c.area)).size}</strong></div>` : ''}`;
      $('customer-body').innerHTML = rows.length ? rows.map((c) => `<tr><td>${esc(c.fullName)}</td><td>${esc(c.contact)}</td><td>${esc(c.area)}</td><td>${esc(c.address)}</td><td>${esc(customerAssigneeName(c))}</td><td>${staff() ? c.sabha ? 'Yes' : 'No' : 'â€”'}</td><td>${staff() ? esc(c.ownerUserIds?.length || 0) : 'â€”'}</td><td>${staff() ? `<button class="ops-link" type="button" data-id="${esc(c.id)}" data-action="editCustomer">Edit</button> ${mode === 'emulator' ? `<button class="ops-link" type="button" data-id="${esc(c.id)}" data-action="deleteCustomer">Delete</button>` : ''}` : ''}</td></tr>`).join('') : empty(8, 'No customers match your search or order access.');
    $('customer-mobile-list').innerHTML = rows.length ? rows.map((c) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(c.fullName)}</strong><span>${esc(c.area)}</span></div><p>${esc(c.contact)}<small>${esc(c.address)}</small></p>${staff() ? `<div class="mobile-record-actions"><button type="button" data-id="${esc(c.id)}" data-action="editCustomer">View / Edit</button>${mode === 'emulator' ? `<button type="button" data-id="${esc(c.id)}" data-action="deleteCustomer">Delete</button>` : ''}</div>` : ''}</article>`).join('') : '<p class="mobile-record-empty">No customers match the current search.</p>';
  }
  function renderOrders() {
    $('order-intake').hidden = !hasPermission(profile, 'systemSettings');
    $('order-intake').textContent = acceptingOrders ? 'Order-taking: open' : 'Order-taking: paused';
    $('order-new').disabled = !acceptingOrders;
    $('order-user').hidden = !staff();
    $('order-user-field').hidden = !staff();
    const selectedUser = $('order-user').value;
    const orderUsers = [...new Map([...eligibleUsers(), ...orders.map((order) => ({ id: order.assignedUserId || order.ownerUid, displayName: assignedUserName(order) }))].filter((row) => row.id).map((row) => [row.id, row])).values()];
    $('order-user').innerHTML = '<option value="">All users</option>' + orderUsers.map((u) => `<option value="${esc(u.id)}">${esc(u.displayName || u.fullName || u.id)}</option>`).join('');
    $('order-user').value = selectedUser;
    renderOrderFilterChips();
    const rows = filteredOrders();
    $('order-cards').innerHTML = `<div class="card ops-stat"><span>Visible orders</span><strong>${rows.length}</strong></div><div class="card ops-stat"><span>Open orders</span><strong>${rows.filter((o) => !['cancelled', 'delivered'].includes(o.status)).length}</strong></div><div class="card ops-stat"><span>Processed value</span><strong>${rupees(rows.filter((o) => !['draft', 'cancelled'].includes(o.status)).reduce((sum, o) => sum + (o.grandTotal || 0), 0))}</strong></div>`;
    const orderActions = (o) => {
      const manageable = staff() || o.ownerUid === user?.uid;
      const specialOrder = o.lines?.some((line) => line.kind === 'special');
      const mayEdit = o.status === 'draft' ? manageable && (!specialOrder || special()) : o.status === 'confirmed' && admin() && (!specialOrder || special());
      const editableStatus = ['draft', 'confirmed', 'in_preparation', 'ready'].includes(o.status);
      const financialReason = invoiceIds.has(o.id) || o.invoiceId ? 'An invoice exists for this order.' : '';
      const lockReason = financialReason || (o.archivedAt ? 'Restore this order to edit it.' : '');
      const button = (kind, label, reason = '') => `<button type="button" data-action="${kind}" data-id="${esc(o.id)}" ${reason ? `disabled title="${esc(reason)}"` : ''}>${label}</button>`;
      return [button('viewOrder', 'View'), mayEdit ? button('editOrder', 'Edit', lockReason) : '',
        o.status === 'draft' && manageable && (!specialOrder || special()) ? button('confirmOrder', 'Confirm', o.archivedAt ? 'Restore this order first.' : '') : '',
        manageable && editableStatus && (!specialOrder || staff()) ? o.archivedAt ? button('restoreOrder', 'Restore', financialReason) : button('archiveOrder', 'Archive', financialReason) : '',
        editableStatus && (staff() || o.status === 'draft' && manageable && !specialOrder) ? button('cancelOrder', 'Cancel', invoiceIds.has(o.id) || o.invoiceId || o.editLockedAt || o.paymentRequestedAt ? 'A financial lock prevents cancellation.' : '') : '',
        staff() && ['confirmed', 'in_preparation', 'ready'].includes(o.status) ? button('advanceOrder', 'Next status', o.archivedAt ? 'Restore this order first.' : '') : '',
        manageable && o.status === 'confirmed' && !invoiceIds.has(o.id) && !o.invoiceId ? button('invoiceOrder', 'Create invoice', o.archivedAt ? 'Restore this order first.' : '') : '',
        manageable && (invoiceIds.has(o.id) || o.invoiceId) ? button('viewInvoice', 'View invoice') : '',
        ].filter(Boolean).join('');
    };
    $('order-body').innerHTML = rows.length ? rows.map((o) => {
      return `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.customerSnapshot?.fullName)}</td><td>${esc(o.orderDate)}</td><td>${esc(assignedUserName(o))}</td><td>${orderStatusBadge(o.status, !!o.archivedAt)}</td><td>${rupees(o.grandTotal)}</td><td class="ops-actions">${orderActions(o)}</td></tr>`;
    }).join('') : empty(7, 'No orders match these filters.');
    $('order-mobile-list').innerHTML = rows.length ? rows.map((o) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(o.orderNumber)}</strong>${orderStatusBadge(o.status, !!o.archivedAt)}</div><p>${esc(o.customerSnapshot?.fullName)}<small>${esc(o.orderDate)} &middot; ${esc(assignedUserName(o))}</small></p><div class="mobile-record-bottom"><b>${rupees(o.grandTotal)}</b><div class="mobile-record-actions">${orderActions(o)}</div></div></article>`).join('') : '<p class="mobile-record-empty">No orders match the current filters.</p>';
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
    const assignment = admin() && !parkedOrder ? `<label class="ops-field">Assigned User<select name="assignedUserId"><option value="" ${!c.assignedUserId ? 'selected' : ''}>Unassigned</option>${customerAssignees().map((row) => `<option value="${esc(row.id)}" ${row.id === c.assignedUserId ? 'selected' : ''}>${esc(row.displayName || row.fullName || row.id)}</option>`).join('')}</select></label>` : '';
    return `${field('Full name', `${prefix}fullName`, 'text', c.fullName, 'required maxlength="120"')}${field('Contact', `${prefix}contact`, 'text', c.contact, 'required maxlength="80"')}${field('Address (optional)', `${prefix}address`, 'text', c.address, 'maxlength="300"')}${field('Area', `${prefix}area`, 'text', c.area, 'required maxlength="100"')}${assignment}`;
  }
  const readCustomerFields = (data, prefix = '', existing = {}) => ({ fullName: data.get(`${prefix}fullName`), contact: data.get(`${prefix}contact`), address: data.get(`${prefix}address`), area: data.get(`${prefix}area`), dateOfBirth: existing.dateOfBirth || null, sabha: existing.sabha === true });
  const stockIds = () => [...new Set([...items.filter((item) => item.active).map((item) => item.id), ...specials.filter((special) => special.active).flatMap((special) => special.components?.map((part) => part.itemId) || [])])];
  async function refreshStock() {
    stockAvailability = new Map(); stockMessage = '';
    try {
      const ids = stockIds();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const readStock = () => callOperation(functions, 'getOrderStock', { itemIds: ids.slice(offset, offset + 100) });
        const result = globalThis.omsLoading?.readTimeout ? await globalThis.omsLoading.readTimeout(readStock, 15000, 'Stock check timed out. The server will verify stock when you save.') : await readStock();
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
    if (!stock || stock.availableQty == null) return 'Stock information is unavailable. Saving the order will check current stock.';
    if (stock?.status === 'blocked') return 'This product is blocked from new orders.';
    if (stock?.status === 'unavailable') return 'This product is unavailable for new orders.';
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
      if (line.kind === 'item') needed.set(line.productId, (needed.get(line.productId) || 0) + line.quantityQty / (line.unitId === '500gm' ? 2 : line.unitId === '250gm' ? 4 : 1));
      else for (const part of specials.find((entry) => entry.id === line.productId)?.components || []) needed.set(part.itemId, (needed.get(part.itemId) || 0) + part.quantityQty * line.quantityQty / 1000);
    }
    for (const [id, quantity] of needed) {
      const stock = stockAvailability.get(id);
      const additional = Math.max(0, quantity - (existing?.stockDeductions?.find((part) => part.itemId === id)?.quantityQty || 0));
      if (stock?.availableQty != null && (stock.status === 'blocked' && additional > 0 || additional > stock.availableQty)) return 'Requested quantity exceeds available stock or an item is blocked. Add stock or reduce the order quantity.';
    }
    return '';
  }
  function itemOptions(selected = '') { return items.filter((i) => i.active).map((i) => { let price = 'price unavailable'; try { price = rupees(toPaise(i.defaultSellingPrice)); } catch { /* Backend rejects invalid catalog prices. */ } return `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(i.name)} — ${price}</option>`; }).join(''); }
  function productOptions(kind, selected = '') { return kind === 'item' ? itemOptions(selected) : specials.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)} — ${rupees(s.finalPricePaise)}</option>`).join(''); }
  function orderLine(line = {}) {
    const kind = line.kind || 'item';
    const productId = line.productId || (kind === 'item' ? items.find((item) => item.active)?.id : specials.find((special) => special.active)?.id);
    const product = items.find((item) => item.id === productId);
    const thumbnail = kind === 'item' && productImage(product?.name || line.itemSnapshot?.name) ? `<img class="order-product-thumb" src="${productImage(product?.name || line.itemSnapshot?.name)}" alt="" loading="lazy" onerror="this.hidden=true">` : '<span class="order-product-thumb order-product-placeholder" aria-hidden="true">🍬</span>';
    const notice = stockNotice(kind, productId);
    const choices = availableOrderUnits(profile?.role).filter((unit) => (product?.name || line.itemSnapshot?.name || '').trim().toLocaleLowerCase() === 'gift packing' ? unit.id === 'pcs' : unit.id !== 'pcs');
    const legacy = kind === 'item' && line.productId && !line.orderUnitId;
    const selectedUnit = legacy ? '__legacy__' : line.orderUnitId || choices[0].id;
    const legacyOption = legacy ? `<option value="__legacy__" selected>Current: ${esc(line.itemSnapshot?.unitSymbol || 'item unit')}</option>` : '';
    const missingOption = line.orderUnitId && !choices.some((unit) => unit.id === line.orderUnitId) ? '<option value="" selected>Choose an active permitted unit</option>' : '';
    const unitField = kind === 'item' ? `<label class="order-line-unit">Unit<select name="unitId" required>${legacyOption}${missingOption}${choices.map((unit) => `<option value="${esc(unit.id)}" ${unit.id === selectedUnit ? 'selected' : ''}>${esc(unit.label)}</option>`).join('')}</select></label>` : '';
    const quantityField = field('Quantity', 'quantity', 'text', line.quantityQty ? line.quantityQty / 1000 : 1, 'inputmode="numeric" pattern="[1-9][0-9]*" title="Enter a whole number of at least 1" required').replace('<input ', '<span class="order-quantity-control"><button type="button" data-quantity-step="-1" aria-label="Decrease quantity">−</button><input ').replace('</label>', '<button type="button" data-quantity-step="1" aria-label="Increase quantity">+</button></span></label>');
    return `<div class="ops-line order-entry-line"><div class="order-line-image">${thumbnail}</div><label class="order-line-type">Type<select name="kind"><option value="item" ${kind === 'item' ? 'selected' : ''}>Regular item</option>${special() ? `<option value="special" ${kind === 'special' ? 'selected' : ''}>Special product</option>` : ''}</select></label><label class="order-line-product">Product<select name="productId">${productOptions(kind, line.productId)}</select><small class="order-stock-hint">${esc(stockLabel(kind, productId))}</small><small class="order-stock-warning" ${notice ? '' : 'hidden'}>${esc(notice)}</small></label>${quantityField}${unitField}<button type="button" class="ops-link order-line-remove" data-remove-line aria-label="Remove order line">Remove</button></div>`;
  }
  function componentLine(part = {}) { return `<div class="ops-line"><label>Item<select name="itemId">${itemOptions(part.itemId)}</select></label>${field('Quantity', 'quantity', 'number', part.quantityQty ? part.quantityQty / 1000 : 1, 'min="0.001" step="0.001" required')}<button type="button" class="button button-outline" data-remove-line>Remove</button></div>`; }

  function viewOrderContent(o) {
    const invoiced = invoiceIds.has(o.id) || Boolean(o.invoiceId);
    const lineSubtotal = (o.lines || []).reduce((sum, line) => sum + (amountValue(line.lineTotalPaise, 0) || 0), 0);
    const subtotal = amountValue(o.subtotal, lineSubtotal);
    const total = amountValue(o.grandTotal, subtotal);
    o.subtotal = subtotal;
    o.grandTotal = total;
    if (!Number.isFinite(Number(o.subtotal)) || !Number.isFinite(Number(o.grandTotal))) console.warn('Order view is using a calculated fallback for missing totals.', { orderId: o.id, subtotal: o.subtotal, grandTotal: o.grandTotal });
    const lines = (o.lines || []).map((line) => {
      const name = line.kind === 'special' ? line.specialSnapshot?.name : line.itemSnapshot?.name;
      const unit = line.kind === 'special' ? 'combo' : orderLineUnitLabel(line);
      const quantity = `${esc(unit || 'Unit unavailable')} × ${esc(qtyText(line.quantityQty))}`;
      const rate = Number.isSafeInteger(line.unitPricePaise) ? rupees(line.unitPricePaise) : '—';
      const amount = Number.isSafeInteger(line.lineTotalPaise) ? rupees(line.lineTotalPaise) : '—';
      return `<tr><th scope="row">${esc(name || 'Item unavailable')}</th><td data-label="Unit / Qty">${quantity}</td><td data-label="Rate">${rate}</td><td data-label="Amount">${amount}</td></tr>`;
    }).join('');
    const discount = Number.isSafeInteger(o.discountPaise) && o.discountPaise > 0 ? `<div><span>Discount</span><strong>−${rupees(o.discountPaise)}</strong></div>` : '';
    return `<div class="order-view"><div class="order-view-summary"><div class="order-view-identity"><strong>${esc(o.orderNumber)}</strong>${orderStatusBadge(o.status, !!o.archivedAt)}</div><dl><div><dt>Customer</dt><dd>${esc(o.customerSnapshot?.fullName || 'Unavailable')}</dd></div><div><dt>Assigned user</dt><dd>${esc(assignedUserName(o))}</dd></div><div><dt>Order date</dt><dd>${esc(o.orderDate || 'Unavailable')}</dd></div><div><dt>Invoice</dt><dd>${invoiced ? 'Created' : 'Not created'}</dd></div></dl>${admin() ? `<div class="order-reassignment"><label class="ops-field">Assigned User<select id="order-reassign-user">${eligibleUsers().map((row) => `<option value="${esc(row.id)}" ${row.id === (o.assignedUserId || o.ownerUid) ? 'selected' : ''}>${esc(row.displayName || row.fullName || 'Unnamed user')}</option>`).join('')}</select></label><button type="button" class="button button-outline" id="order-reassign-save" data-id="${esc(o.id)}">Save assignment</button></div>` : ''}</div><section aria-labelledby="order-view-items-title"><h3 id="order-view-items-title">Items</h3><table class="order-view-table"><thead><tr><th scope="col">Item</th><th scope="col">Unit / Qty</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead><tbody>${lines || '<tr><td colspan="4">No items recorded.</td></tr>'}</tbody></table></section><div class="order-view-total">${Number.isSafeInteger(o.subtotal) ? `<div><span>Subtotal</span><strong>${rupees(o.subtotal)}</strong></div>` : ''}${discount}<div class="order-view-grand"><span>Total</span><strong>${Number.isSafeInteger(o.grandTotal) ? rupees(o.grandTotal) : 'Unavailable'}</strong></div></div>${o.notes ? `<section class="order-view-notes"><h3>Notes</h3><p>${esc(o.notes)}</p></section>` : ''}</div>`;
  }

  function openDialog(nextAction, id = '') {
    if (saving) return;
    if (nextAction !== 'order' || id) stopOrderViewport();
    $('order-dialog').classList?.toggle?.('order-create-mode', nextAction === 'order');
    if (nextAction === 'order' && mobileNavigationParent) $('order-dialog').appendChild(mobileNavigation);
    if (mobileNavigation?.parentNode === $('order-dialog')) mobileNavigation.hidden = nextAction !== 'order' || !!id;
    $('order-dialog-close').textContent = nextAction === 'order' ? '←' : '×';
    $('order-dialog-close').setAttribute?.('aria-label', nextAction === 'order' ? 'Back and close order' : 'Close dialog');
    if (nextAction === 'order' && !parkedOrder) pendingCustomerDetails = null;
    if (nextAction === 'customer') pendingCustomerId = id || uniqueId();
    action = nextAction; targetId = id; $('order-form-error').hidden = true;
    $('order-dialog-save').hidden = nextAction === 'viewOrder';
    $('order-dialog-cancel').textContent = nextAction === 'viewOrder' ? 'Close' : 'Cancel';
    $('order-view-actions').hidden = nextAction !== 'viewOrder';
    $('order-view-actions').innerHTML = '';
    $('order-dialog-save').textContent = nextAction === 'deleteCustomer' ? 'Delete customer' : 'Save';
    const c = customers.find((row) => row.id === id), o = orders.find((row) => row.id === id), s = specials.find((row) => row.id === id);
    $('order-dialog-title').textContent = ({ customer: c ? 'Edit customer' : 'Add customer', order: o ? `Edit ${o.orderNumber}` : 'Create Order', viewOrder: `Order ${o?.orderNumber || ''}`, special: s ? 'Edit combination' : 'Add combination', cancel: 'Cancel order', archive: 'Archive order', restore: 'Restore order', request: 'Record payment request', intake: 'Order-taking', invoice: 'Create invoice' })[nextAction];
    if (nextAction === 'viewOrder' && o) {
      $('order-fields').innerHTML = viewOrderContent(o);
      const actions = $('order-view-actions');
      const invoiced = invoiceIds.has(o.id) || Boolean(o.invoiceId);
      const own = staff() || o.ownerUid === user?.uid;
      const specialOrder = o.lines?.some((line) => line.kind === 'special');
      const canEdit = !invoiced && !o.archivedAt && !o.editLockedAt && !o.paymentRequestedAt && (o.status === 'draft' && own && (!specialOrder || special()) || o.status === 'confirmed' && admin() && (!specialOrder || special()));
      const canInvoice = own && o.status === 'confirmed' && !invoiced && !o.archivedAt;
      actions.innerHTML = `${canEdit ? '<button type="button" class="button button-outline" data-view-action="editOrder"><span aria-hidden="true">✎</span> Edit</button>' : ''}${canInvoice ? '<button type="button" class="button button-primary" data-view-action="invoiceOrder"><span aria-hidden="true">＋</span> Create Invoice</button>' : ''}${own && invoiced ? '<button type="button" class="button button-primary" data-view-action="viewInvoice"><span aria-hidden="true">▣</span> View Invoice</button>' : ''}`;
    }
    if (nextAction === 'customer') $('order-fields').innerHTML = customerFields(c || (parkedOrder ? pendingCustomerDetails || {} : {}));
    if (nextAction === 'deleteCustomer') {
      if (!staff() || !c) return;
      $('order-dialog-title').textContent = 'Delete customer';
      $('order-fields').innerHTML = `<p>Permanently delete <strong>${esc(c.fullName)}</strong>?</p><p>This is allowed only if no transaction records have ever been linked to this customer. This action cannot be undone.</p>`;
    }
    if (nextAction === 'order') {
      const selectedCustomer = o?.customerId || '';
      $('order-fields').innerHTML = `<div class="order-customer-choice"><label class="ops-field" for="order-customer-search">Customer *</label><div class="order-customer-input-wrap"><input id="order-customer-search" type="search" autocomplete="off" placeholder="Search customer by name or phone number" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="order-customer-options" ${o ? 'readonly' : ''}><div id="order-customer-options" class="order-customer-options" role="listbox" hidden></div></div><input type="hidden" name="customerId" id="order-customer" value="${esc(selectedCustomer)}"><small id="order-customer-details"></small><button id="order-add-customer" class="order-add-customer" type="button" ${o ? 'hidden' : ''}><span aria-hidden="true">+</span><span>${pendingCustomerDetails ? 'Edit new customer' : 'Add New Customer'}</span></button></div>${admin() && o ? `<p class="muted order-assignment-choice">Assigned User: ${esc(assignedUserName(o))}. Change assignment from order details.</p>` : admin() ? `<label class="ops-field order-assignment-choice">Assigned User<select name="assignedUserId" required>${orderAssignees().map((row) => `<option value="${esc(row.id)}" ${row.id === user?.uid ? 'selected' : ''}>${esc(row.displayName || row.fullName || 'Unnamed user')}</option>`).join('')}</select></label>` : ''}${field('Order date', 'orderDate', 'date', o?.orderDate || new Date().toISOString().slice(0, 10), 'required')}${field('Delivery date (optional)', 'deliveryDate', 'date', o?.deliveryDate || '')}<div class="ops-lines order-entry-lines"><h3>Order Lines</h3><p id="order-stock-message" class="muted"></p><div id="order-lines">${(o?.lines || [{}]).map(orderLine).join('')}</div><button id="order-add-line" class="button button-outline" type="button">+ Add Line</button><p class="muted">Prices and stock are checked when the order is confirmed.${special() ? ' Special products use whole combos.' : ''}</p></div><label class="ops-field">Notes<textarea name="notes" maxlength="1000">${esc(o?.notes || '')}</textarea></label>`;
      const addCustomerIcon = $('order-add-customer')?.querySelector?.('[aria-hidden="true"]');
      {
      $('order-fields').innerHTML = '<div class="order-flow-header"><nav class="order-stepper" aria-label="Order steps"><span data-step="1" class="is-current">Customer</span><span data-step="2">Items</span><span data-step="3">Review</span></nav><h3>1. Customer details</h3><p class="order-step-subtitle">Select a customer for this order.</p></div>' + $('order-fields').innerHTML;
      orderStep = 1;
      productCategory = '';
      if (!o) $('order-lines')?.replaceChildren?.();
      $('order-fields').querySelector?.('.order-entry-lines')?.classList?.add?.('order-editor-source');
      $('order-dialog-save').hidden = true;
      $('order-fields').insertAdjacentHTML?.('beforeend', '<div class="order-flow-actions"><button type="button" class="button button-outline" id="order-step-back" hidden>Back to Customer</button><button type="button" class="button button-primary" id="order-step-next">Continue to Items</button></div>');
      $('order-fields').querySelector?.('.order-entry-lines')?.insertAdjacentHTML?.('beforebegin', '<section class="order-product-picker" aria-label="Choose order items"><div id="order-product-filters" class="order-product-filters" role="group" aria-label="Filter sweets"></div><div id="order-product-list"></div><div class="order-added-items"><div class="order-added-heading"><button type="button" class="order-cart-toggle" aria-expanded="false" data-toggle-order-cart><span class="order-cart-label">Order Items (0)</span><strong class="order-cart-total"></strong><span class="order-cart-chevron" aria-hidden="true">⌃</span></button></div><div class="order-cart-detail" hidden><div class="order-added-list"></div><button type="button" class="ops-link" data-clear-order-items hidden>Clear all</button></div><div class="order-running-total" hidden></div></div></section>');
      renderProductPicker();
      renderOrderStep();
      }
      if (addCustomerIcon) addCustomerIcon.textContent = '+';
      toggleNewCustomer();
      refreshStock();
    }
    if (nextAction === 'special') $('order-fields').innerHTML = `${field('Name', 'name', 'text', s?.name, 'required maxlength="120"')}${field('Final selling price (â‚¹)', 'price', 'number', s ? s.finalPricePaise / 100 : '', 'min="0" step="0.01" required')}<label class="ops-field">Description<textarea name="description" maxlength="500">${esc(s?.description || '')}</textarea></label><label class="ops-field">Status<select name="active"><option value="true" ${s?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${s?.active === false ? 'selected' : ''}>Inactive</option></select></label><div class="ops-lines"><strong>Recipe: 2 to 4 distinct items</strong><div id="special-components">${(s?.components || [{}, {}]).map(componentLine).join('')}</div><button id="special-add-component" class="button button-outline" type="button">Add component</button></div>`;
    if (nextAction === 'archive') $('order-fields').innerHTML = `<p>Archive ${esc(o?.orderNumber)}? The order and its financial history remain available. Stock is not restored by archiving.</p>${field('Reason (optional)', 'reason', 'text', '', 'maxlength="500"')}`;
    if (nextAction === 'restore') $('order-fields').innerHTML = `<p>Restore ${esc(o?.orderNumber)} to active orders?</p>`;
    if (nextAction === 'request') $('order-fields').innerHTML = `<p>Record that payment was requested for ${esc(o?.orderNumber)}? This locks editing and archiving. It does not send a message or submit a payment.</p>`;
    if (nextAction === 'cancel') $('order-fields').innerHTML = `<p>Cancel ${esc(o?.orderNumber)}? ${o?.archivedAt ? 'Its archive history will remain. ' : ''}${o?.stockReservations?.length ? 'Reserved stock will be released.' : o?.stockDeductions?.length ? 'Deducted stock will be restored.' : 'No stock will change.'} Invoiced or payment-locked orders need a separate correction workflow.</p>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'intake') $('order-fields').innerHTML = `<p>Order-taking is currently ${acceptingOrders ? 'open' : 'paused'}.</p><label class="ops-field">New status<select name="acceptingOrders"><option value="false">Pause</option><option value="true">Resume</option></select></label>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (nextAction === 'invoice') $('order-fields').innerHTML = `<p>Create one invoice from ${esc(o?.orderNumber)}? The invoice checks stock, locks order edits, and uses the saved customer and price snapshots. Sabha is excluded.</p>`;
    if (!$('order-dialog').open) $('order-dialog').showModal();
    if (nextAction === 'order') startOrderViewport();
  }
  function renderProductPicker() {
    const list = $('order-product-list'); if (!list) return;
    const filterBar = $('order-product-filters');
    const shortcuts = [['Kaju', 'Kaju Katri'], ['Kesar', 'Kesar Kaju Katri'], ['Roll', 'Anjir Roll'], ['Cake', 'Anjir Cake'], ['Bar', 'Dryfruit Bar'], ['Mohanthal', 'Mohanthal']];
    const shortcutProducts = shortcuts.map(([label, name]) => ({ label, product: items.find((item) => item.active && String(item.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase()) }));
    if (filterBar) filterBar.innerHTML = `<button type="button" data-product-category="" aria-pressed="${!productCategory}">All</button>${shortcutProducts.map(({ label, product }) => { const id = product?.id || `missing:${label}`; return `<button type="button" data-product-category="${esc(id)}" aria-pressed="${productCategory === id}">${esc(label)}</button>`; }).join('')}`;
    const categoryMatches = (item) => !productCategory || item.id === productCategory;
    const matches = [
      ...items.filter((item) => item.active && categoryMatches(item)).map((item) => ({ ...item, kind: 'item' })),
      ...(special() ? specials.filter((item) => item.active && categoryMatches(item)).map((item) => ({ ...item, kind: 'special' })) : []),
    ];
    const selectedLines = draftLines();
    list.innerHTML = matches.length ? matches.map((item) => {
      const image = item.kind === 'item' ? productImage(item.name) : '';
      const units = item.kind === 'item' ? availableOrderUnits(profile?.role).filter((unit) => (item.name || '').trim().toLocaleLowerCase() === 'gift packing' ? unit.id === 'pcs' : unit.id !== 'pcs').filter((unit) => { try { const price = itemUnitPrice(item, unit.id); return price !== null && price !== undefined && price !== '' && Number.isSafeInteger(toPaise(price)); } catch { return false; } }).sort((a, b) => ({ '500gm': 0, kg: 1, '250gm': 2 }[a.id] ?? 3) - ({ '500gm': 0, kg: 1, '250gm': 2 }[b.id] ?? 3)) : Number.isSafeInteger(item.finalPricePaise) && item.finalPricePaise >= 0 ? [{ id: 'combo', label: 'Combo' }] : [];
      const unitChoices = units.map((unit) => {
        const price = item.kind === 'special' ? item.finalPricePaise : toPaise(itemUnitPrice(item, unit.id));
        const quantity = selectedLines.find((line) => line.kind === item.kind && line.productId === item.id && line.unitId === unit.id)?.quantity || 0;
        const label = `${item.name}, ${unit.id === 'kg' ? '1 KG' : unit.label}`;
        return `<div class="order-unit-choice ${quantity > 0 ? 'is-active' : ''}"><strong>${esc(unit.id === 'kg' ? '1 KG' : unit.label)}</strong><small>${rupees(price)}</small><div class="order-unit-quantity"><button type="button" data-unit-step="-1" aria-label="Decrease ${esc(label)} quantity">−</button><input type="text" inputmode="numeric" pattern="[0-9]*" value="${quantity}" data-unit-quantity data-kind="${item.kind}" data-product-id="${esc(item.id)}" data-unit-id="${esc(unit.id)}" aria-label="Quantity for ${esc(label)}"><button type="button" data-unit-step="1" aria-label="Increase ${esc(label)} quantity">+</button></div></div>`;
      }).join('');
      return `<article class="order-product-card"><span class="order-product-card-image">${image ? `<img src="${image}" alt="" loading="lazy" onerror="this.hidden=true">` : '<span aria-hidden="true">◇</span>'}</span><div class="order-product-info"><strong>${esc(item.name)}</strong><div class="order-unit-choices" role="group" aria-label="Units for ${esc(item.name)}">${unitChoices || '<small>Price unavailable</small>'}</div>${item.kind === 'item' ? `<small class="order-product-stock">${esc(stockLabel('item', item.id))}</small>` : ''}</div></article>`;
    }).join('') : '<p class="order-product-empty">No sweets match your search.</p>';
  }
  function draftLines() {
    return [...($('order-lines')?.children || [])].map((row) => {
      const kind = row.querySelector('[name=kind]')?.value || 'item';
      const productId = row.querySelector('[name=productId]')?.value;
      const unitId = row.querySelector('[name=unitId]')?.value || (kind === 'special' ? 'combo' : 'kg');
      const product = kind === 'special' ? specials.find((item) => item.id === productId) : items.find((item) => item.id === productId);
      let price = null;
      try { if (product) { const configured = kind === 'special' ? product.finalPricePaise : itemUnitPrice(product, unitId); if (configured !== null && configured !== undefined && configured !== '') price = kind === 'special' ? configured : toPaise(configured); } } catch { /* Missing catalog price is shown as unavailable. */ }
      const quantity = Number(row.querySelector('[name=quantity]')?.value);
      return { row, kind, productId, unitId, product, price, quantity, total: Number.isSafeInteger(price) && Number.isSafeInteger(quantity) && quantity > 0 ? price * quantity : null };
    });
  }
  const draftTotal = (lines) => lines.every((line) => line.total !== null && Number.isSafeInteger(line.total)) ? lines.reduce((sum, line) => sum + line.total, 0) : null;
  const draftError = (lines) => !lines.length ? 'Add at least one item.' : lines.some((line) => !line.productId || !line.product) ? 'Select a valid item.' : lines.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity < 1) ? 'Enter a whole-number quantity of at least 1.' : lines.some((line) => line.price === null || !Number.isSafeInteger(line.price)) ? 'A selected unit has no valid price.' : new Set(lines.map((line) => `${line.kind}:${line.productId}:${line.unitId}`)).size !== lines.length ? 'Each item and unit may be added only once.' : stockWarning(lines.map((line) => ({ kind: line.kind, productId: line.productId, unitId: line.unitId, quantityQty: line.quantity * 1000 }))) || '';
  function setUnitQuantity(input, quantity) {
    const { kind, productId, unitId } = input.dataset;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(quantity * 1000)) return false;
    const lines = draftLines();
    const existing = lines.find((line) => line.kind === kind && line.productId === productId && line.unitId === unitId);
    const proposed = lines.filter((line) => line !== existing).map((line) => ({ kind: line.kind, productId: line.productId, unitId: line.unitId, quantityQty: line.quantity * 1000 }));
    if (quantity) proposed.push({ kind, productId, unitId, quantityQty: quantity * 1000 });
    const warning = quantity > (existing?.quantity || 0) ? stockWarning(proposed) : '';
    if (warning) { showToast(warning, 'toast-error'); return false; }
    if (existing && quantity === 0) existing.row.remove();
    else if (existing) existing.row.querySelector('[name=quantity]').value = String(quantity);
    else if (quantity) $('order-lines').insertAdjacentHTML('beforeend', orderLine({ kind, productId, ...(kind === 'item' ? { orderUnitId: unitId } : {}), quantityQty: quantity * 1000 }));
    input.value = String(quantity);
    input.removeAttribute?.('aria-invalid');
    input.closest('.order-unit-choice')?.classList.toggle('is-active', quantity > 0);
    updateStockLabels();
    renderAddedItems();
    return true;
  }
  function renderAddedItems() {
    const fields = $('order-fields'); if (!fields?.querySelector) return;
    let panel = fields.querySelector('.order-added-items');
    const lines = draftLines();
    if (!panel) return;
    const cards = lines.map((line, index) => { const image = line.kind === 'item' ? productImage(line.product?.name) : ''; return `<article class="order-added-card"><div class="order-added-top">${image ? `<img src="${image}" alt="" loading="lazy" onerror="this.hidden=true">` : '<span class="order-product-placeholder" aria-hidden="true">◇</span>'}<div><strong>${esc(line.product?.name || 'Item unavailable')}</strong><small>${esc(availableOrderUnits(profile?.role).find((unit) => unit.id === line.unitId)?.label || line.unitId)} × ${line.quantity} · ${line.price == null ? 'Rate unavailable' : rupees(line.price)}</small></div><strong>${line.total == null ? 'Unavailable' : rupees(line.total)}</strong></div><button type="button" class="ops-link" data-remove-order-item="${index}" aria-label="Remove ${esc(line.product?.name || 'item')}">Remove</button></article>`; }).join('');
    panel.querySelector('.order-cart-label').textContent = `Order Items (${lines.length})`;
    panel.querySelector('.order-cart-total').textContent = draftTotal(lines) === null ? 'Unavailable' : rupees(draftTotal(lines));
    panel.querySelector('[data-clear-order-items]').hidden = !lines.length;
    panel.querySelector('.order-added-list').innerHTML = cards || '<p class="order-product-empty">No items added yet.</p>';
    panel.querySelector('.order-running-total').textContent = `Running total: ${draftTotal(lines) === null ? 'Unavailable' : rupees(draftTotal(lines))}`;
  }
  function renderOrderStep() {
    if (action !== 'order') return;
    const fields = $('order-fields');
    if (!fields?.querySelector) return;
    const customerPart = fields.querySelector('.order-customer-choice');
    const assignmentPart = fields.querySelector('.order-assignment-choice');
    const dateFields = [...fields.querySelectorAll('input[name=orderDate],input[name=deliveryDate]')].map((input) => input.closest('label')).filter(Boolean);
    const notesPart = fields.querySelector('textarea[name=notes]')?.closest('label');
    const itemsPart = fields.querySelector('.order-entry-lines');
    const review = fields.querySelector('.order-review-panel');
    if (customerPart) customerPart.hidden = orderStep !== 1;
    if (assignmentPart) assignmentPart.hidden = orderStep !== 1;
    if (notesPart) notesPart.hidden = orderStep !== 1;
    dateFields.forEach((field) => { if (field) field.hidden = true; });
    if (itemsPart) itemsPart.hidden = orderStep !== 2;
    const picker = fields.querySelector('.order-product-picker'); if (picker) picker.hidden = orderStep !== 2;
    const added = fields.querySelector('.order-added-items'); if (added) added.hidden = orderStep !== 2;
    if (orderStep === 3) {
      const selected = customers.find((row) => row.id === fields.querySelector('#order-customer')?.value) || pendingCustomerDetails || {};
      const lines = draftLines(), total = draftTotal(lines);
      const rows = lines.map((line) => { const image = line.kind === 'item' ? productImage(line.product?.name) : ''; const unit = availableOrderUnits(profile?.role).find((choice) => choice.id === line.unitId)?.label || line.unitId; return `<tr><th scope="row"><span class="order-review-product">${image ? `<img src="${image}" alt="" loading="lazy" onerror="this.hidden=true">` : '<span class="order-product-placeholder" aria-hidden="true">◇</span>'}<span>${esc(line.product?.name || 'Item unavailable')}</span></span></th><td data-label="Unit">${esc(unit)}</td><td data-label="Qty">${line.quantity}</td><td data-label="Rate">${line.price == null ? 'Unavailable' : rupees(line.price)}</td><td data-label="Total"><strong>${line.total == null ? 'Unavailable' : rupees(line.total)}</strong></td></tr>`; }).join('');
      const note = fields.querySelector('[name=notes]')?.value?.trim();
      const summary = `<section class="order-review-panel"><section class="order-review-card order-review-customer"><div class="order-review-heading"><strong><span aria-hidden="true">♙</span> Customer</strong><button type="button" class="ops-link" data-edit-order-step="1">Edit</button></div><p><strong>${esc(selected.fullName || 'Not selected')}</strong>${selected.contact ? `<br>${esc(selected.contact)}` : ''}${selected.address || selected.area ? `<br>${esc([selected.address, selected.area].filter(Boolean).join(', '))}` : ''}</p></section><section class="order-review-card order-review-notes"><div class="order-review-heading"><strong><span aria-hidden="true">▤</span> Notes</strong><button type="button" class="ops-link" data-edit-order-step="1">Edit</button></div><p>${note ? esc(note) : 'No notes'}</p></section><section class="order-review-card order-review-items"><div class="order-review-heading"><strong><span aria-hidden="true">🛒</span> Order items (${lines.length})</strong><button type="button" class="ops-link" data-edit-order-step="2">Edit Items</button></div><div class="order-review-table-wrap"><table class="order-review-table"><thead><tr><th scope="col">Item</th><th scope="col">Unit</th><th scope="col">Qty</th><th scope="col">Rate</th><th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table></div></section><section class="order-review-card order-review-summary"><div class="order-review-total"><span>Subtotal (${lines.length} items)</span><strong>${total == null ? 'Unavailable' : rupees(total)}</strong><b>Total</b><strong>${total == null ? 'Unavailable' : rupees(total)}</strong></div></section></section>`;
      if (review) review.outerHTML = summary; else fields.querySelector('.order-flow-actions')?.insertAdjacentHTML?.('beforebegin', summary);
    } else if (review) review.remove();
    if (orderStep === 2) renderAddedItems();
    const heading = fields.querySelector('.order-flow-header h3');
    if (heading) heading.textContent = ['1. Customer details', '2. Add sweets to order', targetId ? '3. Review and save changes' : '3. Review and create order'][orderStep - 1];
    const subtitle = fields.querySelector('.order-step-subtitle');
    if (subtitle) subtitle.textContent = ['Select a customer for this order.', 'Select sweets with required unit and quantity.', 'Check details and confirm.'][orderStep - 1];
    fields.querySelectorAll('.order-stepper span').forEach((step, index) => { step.classList.toggle('is-current', index + 1 === orderStep); step.classList.toggle('is-complete', index + 1 < orderStep); });
    const next = fields.querySelector('#order-step-next');
    if (next) next.textContent = orderStep === 1 ? 'Continue to Items' : orderStep === 2 ? 'Continue to Review' : targetId ? 'Save Changes' : 'Save Order';
    const back = fields.querySelector('#order-step-back');
    if (back) { back.hidden = orderStep === 1; back.textContent = orderStep === 3 ? 'Back to Items' : 'Back to Customer'; }
  }
  function customerMatches(query) {
    const term = query.trim().toLocaleLowerCase();
    return customers.filter((row) => `${row.fullName || ''} ${row.contact || ''}`.toLocaleLowerCase().includes(term)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  function showCustomerOptions() {
    const search = $('order-customer-search'), list = $('order-customer-options');
    if (!search || !list || search.readOnly) return;
    const matches = customerMatches($('order-customer')?.value ? '' : search.value);
    list.innerHTML = matches.length ? matches.map((row) => `<button type="button" role="option" aria-selected="${row.id === $('order-customer')?.value}" class="order-customer-option ${row.id === $('order-customer')?.value ? 'is-selected' : ''}" data-customer-id="${esc(row.id)}"><strong>${esc(row.fullName)}</strong><small>${esc(row.contact)}</small><span class="order-customer-check" aria-hidden="true">${row.id === $('order-customer')?.value ? '●' : '○'}</span></button>`).join('') : `<div class="order-customer-empty">No customers found.<button type="button" id="order-add-customer-empty">+ Add New Customer</button></div>`;
    const addCustomerButton = $('order-add-customer-empty');
    if (addCustomerButton) addCustomerButton.textContent = '+ Add New Customer';
    list.hidden = false; search.setAttribute?.('aria-expanded', 'true');
  }
  function hideCustomerOptions() {
    const search = $('order-customer-search'), list = $('order-customer-options');
    if (list) list.hidden = true;
    if (search) search.setAttribute?.('aria-expanded', 'false');
  }
  function selectCustomer(customerId) {
    const input = $('order-customer'), search = $('order-customer-search');
    if (!input || !search) return;
    input.value = customerId;
    const customer = customers.find((row) => row.id === customerId);
    search.value = customer?.fullName || (customerId === '__new__' ? pendingCustomerDetails?.fullName : '') || '';
    const details = $('order-customer-details');
    if (details) details.textContent = customer ? [customer.contact, customer.area, customer.address].filter(Boolean).join(' · ') : customerId === '__new__' && pendingCustomerDetails ? [pendingCustomerDetails.contact, pendingCustomerDetails.area].filter(Boolean).join(' · ') : '';
    const button = $('order-add-customer');
    if (button?.lastElementChild) button.lastElementChild.textContent = pendingCustomerDetails ? 'Edit new customer' : 'Add New Customer';
    hideCustomerOptions();
    if (action === 'order' && orderStep === 1) showCustomerOptions();
  }
  function toggleNewCustomer() { selectCustomer($('order-customer')?.value || ''); }
  function openCustomerFromOrder() {
    if (saving || action !== 'order' || parkedOrder || !$('order-customer') || $('order-customer-search').readOnly) return;
    hideCustomerOptions();
    const fields = $('order-fields'), assignedUserId = admin() ? fields.querySelector?.('[name=assignedUserId]')?.value || null : null, fragment = document.createDocumentFragment();
    while (fields.firstChild) fragment.appendChild(fields.firstChild);
    parkedOrder = { fragment, targetId, title: $('order-dialog-title').textContent, assignedUserId };
    openDialog('customer');
  }
  function restoreOrderForm(customerId = null) {
    if (!parkedOrder) return;
    const previous = parkedOrder;
    parkedOrder = null;
    const fields = $('order-fields'); fields.innerHTML = ''; fields.appendChild(previous.fragment);
    action = 'order'; targetId = previous.targetId;
    $('order-dialog').classList?.toggle?.('order-create-mode', true);
    if (mobileNavigation?.parentNode === $('order-dialog')) mobileNavigation.hidden = !!targetId;
    $('order-dialog-close').textContent = targetId ? '×' : '←';
    $('order-dialog-close').setAttribute?.('aria-label', targetId ? 'Close dialog' : 'Back and close order');
    $('order-dialog-title').textContent = previous.title;
    $('order-dialog-save').textContent = 'Save';
    $('order-form-error').hidden = true;
    const select = $('order-customer');
    if (select && customerId) select.value = customerId;
    else if (select && pendingCustomerDetails) select.value = '__new__';
    toggleNewCustomer();
    updateStockLabels();
    renderOrderStep();
    startOrderViewport();
  }
  function closeOrderDialog() {
    if (parkedOrder) restoreOrderForm();
    else if (!saving) {
      const hasDraft = action === 'order' && ($('order-customer')?.value || draftLines().length || $('order-fields').querySelector?.('[name=notes]')?.value?.trim());
      if (!hasDraft || !globalThis.confirm || globalThis.confirm('Discard this order draft?')) $('order-dialog').close();
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || action === 'viewOrder') return;
    if (action === 'order' && $('order-dialog').classList?.contains?.('order-create-mode') && orderStep !== 3) return;
    if (action === 'order' && targetId && globalThis.confirm && !globalThis.confirm('Save changes to this order?')) return;
    saving = true;
    const data = new FormData(event.currentTarget), button = $('order-dialog-save');
    button.disabled = true; $('order-form-error').hidden = true;
    const flowButton = $('order-fields').querySelector?.('#order-step-next'); if (flowButton) flowButton.disabled = true;
    try {
      let name, payload, result;
      if (action === 'deleteCustomer') { if (!staff()) throw new Error('Access denied: staff access is required.'); name = 'deleteCustomer'; payload = { customerId: targetId }; } else if (action === 'customer') {
        if (!staff() && !parkedOrder) throw new Error('Staff access is required.');
        payload = validateCustomerInput(readCustomerFields(data, '', customers.find((row) => row.id === targetId)));
        if (admin()) payload.assignedUserId = parkedOrder ? parkedOrder.assignedUserId : data.get('assignedUserId') || null;
        const duplicate = customers.find((c) => c.id !== targetId && normalize(c.contact) === normalize(payload.contact));
        if (duplicate && parkedOrder && (!admin() || duplicate.assignedUserId === payload.assignedUserId)) {
          pendingCustomerDetails = null; restoreOrderForm(duplicate.id); showToast('Existing customer selected.'); return;
        }
        if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}.`);
        if (parkedOrder) {
          if (staff()) {
            const saveNewCustomer = () => saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: true });
            const saved = globalThis.omsLoading?.withLoading ? await globalThis.omsLoading.withLoading(saveNewCustomer, 'Saving customer…') : await saveNewCustomer();
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
        if (!staff()) throw new Error('Access denied: staff access is required.');
        payload = { specialId: targetId || undefined, name: data.get('name'), description: data.get('description'), finalPricePaise: toPaise(data.get('price')), active: data.get('active') === 'true', components: [...$('special-components').children].map((row) => { const itemId = row.querySelector('[name=itemId]').value; return { itemId, unitId: items.find((item) => item.id === itemId)?.defaultUnitId, quantityQty: toMilli(row.querySelector('[name=quantity]').value) }; }) };
        name = 'saveSpecialProduct';
      } else if (action === 'order') {
        const selected = data.get('customerId');
        if (!selected) throw new Error('Select a customer or add a new customer.');
        if (selected === '__new__' && !pendingCustomerDetails) throw new Error('Enter new customer details before saving the order.');
        payload = { orderId: targetId || pendingOrderId || uniqueId(), customerId: selected === '__new__' ? undefined : selected, newCustomer: selected === '__new__' ? pendingCustomerDetails : undefined, ...(admin() && !targetId ? { assignedUserId: data.get('assignedUserId') } : {}), orderDate: data.get('orderDate'), deliveryDate: data.get('deliveryDate') || null, notes: data.get('notes'), lines: [...$('order-lines').children].map((row) => { const kind = row.querySelector('[name=kind]').value, unitId = row.querySelector('[name=unitId]')?.value; return { kind, productId: row.querySelector('[name=productId]').value, quantityQty: toOrderQuantity(row.querySelector('[name=quantity]').value), ...(kind === 'item' && unitId && unitId !== '__legacy__' ? { unitId } : {}) }; }) };
        if (!special() && payload.lines.some((line) => line.kind === 'special')) throw new Error('Only Admin may create or edit a special order.');
        if (selected === '__new__') {
          const duplicate = customers.find((c) => normalize(c.contact) === normalize(payload.newCustomer.contact));
          if (duplicate) throw new Error(`A customer with this contact already exists: ${duplicate.fullName}. Select that customer.`);
        }
        const stockToken = globalThis.omsLoading?.start('Checking stock…');
        try { await refreshStock(); }
        finally { globalThis.omsLoading?.stop(stockToken); }
        const warning = stockWarning(payload.lines, orders.find((row) => row.id === targetId));
        if (warning) throw new Error(warning);
        pendingOrderId = payload.orderId; name = 'saveOrderDraft';
      } else if (action === 'archive') { name = 'archiveOrder'; payload = { orderId: targetId, reason: data.get('reason') || '' }; }
      else if (action === 'restore') { name = 'restoreOrder'; payload = { orderId: targetId }; }
      else if (action === 'request') { name = 'requestOrderPayment'; payload = { orderId: targetId }; }
      else if (action === 'cancel') { name = 'cancelOrder'; payload = { orderId: targetId, reason: data.get('reason') }; }
      else if (action === 'intake') { name = 'setOrderTaking'; payload = { acceptingOrders: data.get('acceptingOrders') === 'true', reason: data.get('reason') }; }
      else { name = 'createInvoiceFromOrder'; payload = { orderId: targetId }; }
      if (action === 'customer') {
        if (globalThis.omsLoading?.withLoading) await globalThis.omsLoading.withLoading(() => saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: !targetId }), 'Saving customer…');
        else await saveCustomerDirect(db, auth, payload, { customerId: pendingCustomerId, create: !targetId });
      } else result = await callOperation(functions, name, payload);
      pendingOrderId = ''; $('order-dialog').close(); showToast(action === 'order' && !targetId ? `Order ${result?.orderNumber || ''} saved.` : action === 'deleteCustomer' ? 'Customer deleted.' : action === 'invoice' ? 'Invoice created. Record payment from the Invoices page.' : 'Saved successfully.');
      try { await refresh(['customer', 'deleteCustomer'].includes(action) ? 'customers' : action === 'special' ? 'specials' : 'orders'); }
      catch (error) { showToast(`Saved, but records could not refresh: ${cleanError(error)}`, 'toast-error'); }
      if (action === 'invoice') viewInvoice(orders.find((row) => row.id === targetId)?.orderNumber);
    } catch (error) { $('order-form-error').textContent = action === 'customer' ? customerSaveError(error) : cleanError(error); $('order-form-error').hidden = false; }
    finally { saving = false; button.disabled = false; if (flowButton) flowButton.disabled = false; }
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
    const key = `${nextAction}:${id}`;
    if (pendingOrderActions.has(key)) return;
    pendingOrderActions.add(key);
    try {
      if (nextAction === 'confirmOrder') {
        const result = await callOperation(functions, 'confirmOrder', { orderId: id });
        showToast(`Order ${o.orderNumber} ${result?.status || 'confirmed'}.`);
        await refresh('orders'); return;
      }
      if (nextAction === 'advanceOrder') {
        const transitions = { confirmed: 'in_preparation', in_preparation: 'ready', ready: 'delivered' };
        await callOperation(functions, 'advanceOrder', { orderId: id, nextStatus: transitions[o.status] });
      }
      showToast('Order updated.'); await refresh('orders');
    } catch (error) { showToast(cleanError(error), 'toast-error'); }
    finally { pendingOrderActions.delete(key); }
  }

  const activityFilters = () => ({
    actor: $('order-activity-actor').value.trim(), customer: $('order-activity-customer').value.trim(),
    order: $('order-activity-order').value.trim(), invoice: $('order-activity-invoice').value.trim(), payment: $('order-activity-payment').value.trim(), type: $('order-activity-type').value,
    from: $('order-activity-from').value, to: $('order-activity-to').value,
  });
  const activityChanges = (row) => changeSummary(row);
  function renderActivity() {
    $('order-activity-page').textContent = `Page ${activityPage}${activityHasMore ? ' Â· more available' : ''}`;
    $('order-activity-prev').disabled = activityPage === 1;
    $('order-activity-next').disabled = !activityHasMore;
    $('order-activity-body').innerHTML = activityRows.length ? activityRows.map((row) => { const ref = references(row); return `<tr><td>${esc(activityDate(row.at))}</td><td>${esc(actionLabel(row.type))}</td><td>${esc(ref.order)}</td><td>${esc(ref.actor)}</td><td>${esc(ref.customer)}</td><td>${esc(activityChanges(row))}</td><td>${esc(row.outcome || 'Success')}</td></tr>`; }).join('') : empty(7, 'No order actions match these filters.');
    $('order-activity-cards').innerHTML = activityRows.length ? activityRows.map((row) => {
      const ref = references(row);
      const field = (label, value, extra = '') => `<div class="order-activity-card-field ${extra}"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
      return `<article class="order-activity-card"><dl>${field('When', activityDate(row.at), 'order-activity-card-when')}${field('Action', actionLabel(row.type), 'order-activity-card-action')}${field('Order', ref.order)}${field('Actor', ref.actor)}${ref.customer !== 'Not available' ? field('Customer', ref.customer) : ''}${field('Changes', activityChanges(row))}${field('Outcome', row.outcome || 'Success')}</dl></article>`;
    }).join('') : '<p class="order-activity-cards-empty">No order actions match these filters.</p>';
  }
  async function loadActivity(reset = false) {
    if (!profile) return;
    const revision = ++activityRevision;
    if (reset) { activityPage = 1; activityCursors = [null]; }
    $('order-activity-message').textContent = '';
    stopActivityLoad();
    const token = globalThis.omsLoading?.start('Loading order activity…') || null;
    activityLoadToken = token;
    try {
      const result = await listActivity(db, profile, user?.uid, 'order', activityFilters(), activityCursors[activityPage - 1]);
      if (revision !== activityRevision) return;
      activityRows = result?.rows || []; activityNext = result?.cursor || null; activityHasMore = result?.hasMore === true;
      renderActivity(); $('order-activity-message').textContent = '';
    } catch (error) { if (revision === activityRevision) { activityRows = []; activityHasMore = false; renderActivity(); $('order-activity-message').textContent = `Could not load activity: ${cleanError(error)}`; } }
    finally { if (activityLoadToken === token) stopActivityLoad(); }
  }
  async function exportActivity() {
    $('order-activity-export').disabled = true;
    try {
      const rows = [], seen = new Set(); let cursor = null;
      do {
        const result = await listActivity(db, profile, user?.uid, 'order', activityFilters(), cursor);
        rows.push(...result.rows);
        if (!result.hasMore) break;
        if (!result.cursor || seen.has(result.cursor)) throw new Error('Activity export could not complete.');
        cursor = result.cursor; seen.add(cursor);
      } while (true);
      if (!rows.length) return showToast('No activity matches these filters.', 'toast-error');
      await downloadXlsx('order-activity', [['Order Activity', rows.map((row) => { const ref = references(row); return { When: activityDate(row.at), Action: actionLabel(row.type), Order: ref.order, Actor: ref.actor, Customer: ref.customer, Changes: activityChanges(row), Outcome: row.outcome || 'Success' }; })]]);
    } catch (error) { showToast(cleanError(error), 'toast-error'); }
    finally { $('order-activity-export').disabled = false; }
  }

  document.addEventListener('oms:pagechange', (event) => {
    if (event.detail.page !== 'orders') { stopOrderInitialLoader(); stopActivityLoad(); $('order-loading').hidden = true; }
    for (const page of recordLoadTokens.keys()) if (page !== event.detail.page) stopRecordLoad(page);
    if (['customers', 'orders', 'specials'].includes(event.detail.page) && profile) refresh(event.detail.page, event.detail.page === 'orders');
  });
  $('customer-new').addEventListener('click', () => openDialog('customer'));
  $('order-new').addEventListener('click', () => { pendingOrderId = ''; openDialog('order'); });
  $('special-new').addEventListener('click', () => { if (staff()) openDialog('special'); });
  $('order-intake').addEventListener('click', () => { if (hasPermission(profile, 'systemSettings')) openDialog('intake'); });
  $('order-activity-apply').addEventListener('click', () => loadActivity(true));
  $('order-activity-export').addEventListener('click', exportActivity);
  $('order-activity-prev').addEventListener('click', () => { if (activityPage > 1) { activityPage--; loadActivity(); } });
  $('order-activity-next').addEventListener('click', () => { if (activityHasMore && activityNext) { activityCursors[activityPage] = activityNext; activityPage++; loadActivity(); } });
  ['customers', 'specials'].forEach((page) => $(page === 'specials' ? 'special-refresh' : 'customer-refresh').addEventListener('click', () => refresh(page)));
  $('order-refresh').addEventListener('click', () => refresh('orders'));
  $('order-retry').addEventListener('click', () => refresh('orders'));
  ['customer-search'].forEach((id) => $(id).addEventListener('input', renderCustomers));
  $('order-filters').addEventListener('submit', (event) => { event.preventDefault(); applyOrderFilters(); });
  const markOrderFiltersPending = () => { $('order-filter-pending').hidden = Object.entries(orderFilterIds).every(([key, id]) => ($(id).value || '').trim() === (appliedOrderFilters[key] || '')); };
  $('order-filters').addEventListener('input', markOrderFiltersPending);
  $('order-filters').addEventListener('change', markOrderFiltersPending);
  $('order-clear').addEventListener('click', () => applyOrderFilters(blankOrderFilters()));
  $('order-active-filters').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-filter]');
    if (!button) return;
    const filters = { ...appliedOrderFilters };
    if (button.dataset.filter === 'dates') { filters.from = ''; filters.to = ''; }
    else filters[button.dataset.filter] = '';
    applyOrderFilters(filters);
  });
  ['special-search', 'special-status'].forEach((id) => $(id).addEventListener('input', renderSpecials));
  $('customer-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog(button.dataset.action === 'deleteCustomer' ? 'deleteCustomer' : 'customer', button.dataset.id); });
  $('customer-mobile-list').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog(button.dataset.action === 'deleteCustomer' ? 'deleteCustomer' : 'customer', button.dataset.id); });
  $('special-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button && staff()) openDialog('special', button.dataset.id); });
  $('order-body').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) runOrderAction(button.dataset.action, button.dataset.id); });
  $('order-mobile-list').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) runOrderAction(button.dataset.action, button.dataset.id); });
  $('order-view-actions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view-action]');
    if (!button || action !== 'viewOrder') return;
    const id = targetId;
    $('order-dialog').close();
    runOrderAction(button.dataset.viewAction, id);
  });
  $('order-fields').addEventListener('input', (event) => {
    if (event.target.id === 'order-customer-search') { $('order-customer').value = ''; $('order-customer-details').textContent = ''; showCustomerOptions(); }
    if (event.target.matches?.('[data-unit-quantity]')) {
      const value = event.target.value.trim();
      const quantity = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(quantity * 1000)) { event.target.setAttribute?.('aria-invalid', 'true'); return; }
      if (!setUnitQuantity(event.target, quantity)) event.target.setAttribute?.('aria-invalid', 'true');
      return;
    }
  });
  $('order-fields').addEventListener('focusin', (event) => {
    if (event.target.id !== 'order-customer-search') return;
    if ($('order-customer')?.value) event.target.value = '';
    showCustomerOptions();
  });
  $('order-fields').addEventListener('focusout', (event) => {
    if (event.target.id === 'order-customer-search' && $('order-customer')?.value) {
      const id = $('order-customer').value;
      event.target.value = customers.find((row) => row.id === id)?.fullName || (id === '__new__' ? pendingCustomerDetails?.fullName : '') || '';
    }
    if (!event.target.matches?.('[data-unit-quantity]')) return;
    const { kind, productId, unitId } = event.target.dataset;
    event.target.value = String(draftLines().find((line) => line.kind === kind && line.productId === productId && line.unitId === unitId)?.quantity || 0);
    event.target.removeAttribute?.('aria-invalid');
  });
  $('order-fields').addEventListener('keydown', (event) => {
    if (event.target.id !== 'order-customer-search') return;
    if (event.key === 'Escape') { hideCustomerOptions(); event.target.blur(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); $('order-customer-options')?.querySelector('button')?.focus(); }
  });
  document.addEventListener('click', (event) => { if (action === 'order' && orderStep === 1) return; if (!event.target.closest?.('.order-customer-choice')) hideCustomerOptions(); });
  $('order-fields').addEventListener('change', (event) => {
    if (event.target.name === 'productId') refreshStock();
    if (event.target.name === 'unitId') updateStockLabels();
    if (event.target.name === 'kind') { const row = event.target.closest('.ops-line'); row.querySelector('[name=productId]').innerHTML = productOptions(event.target.value); const unit = row.querySelector('.order-line-unit'); if (unit) { unit.hidden = event.target.value !== 'item'; unit.querySelector('select').disabled = event.target.value !== 'item'; } refreshStock(); }
  });
  $('order-fields').addEventListener('click', (event) => {
    if (event.target.closest?.('#order-reassign-save')) {
      const button = event.target.closest('#order-reassign-save');
      const assignedUserId = $('order-reassign-user')?.value;
      if (!admin() || !assignedUserId || button.disabled) return;
      button.disabled = true;
      void callOperation(functions, 'reassignOrder', { orderId: button.dataset.id, assignedUserId }).then(async () => {
        showToast('Assigned user updated.');
        try {
          await refresh('orders');
          const updated = orders.find((row) => row.id === button.dataset.id);
          if (updated && action === 'viewOrder') $('order-fields').innerHTML = viewOrderContent(updated);
        } catch (error) { showToast(`Assignment saved, but records could not refresh: ${cleanError(error)}`, 'toast-error'); }
      }).catch((error) => { showToast(cleanError(error), 'toast-error'); }).finally(() => { button.disabled = false; });
      return;
    }
    const category = event.target.closest?.('[data-product-category]');
    if (category) { productCategory = category.dataset.productCategory; renderProductPicker(); return; }
    if (event.target.closest?.('[data-toggle-order-cart]')) {
      const toggle = event.target.closest('[data-toggle-order-cart]');
      const panel = toggle.closest('.order-added-items');
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      panel.querySelector('.order-cart-detail').hidden = !expanded;
      panel.classList.toggle('is-expanded', expanded);
      return;
    }
    const unitStep = event.target.closest?.('[data-unit-step]');
    if (unitStep) {
      const input = unitStep.closest('.order-unit-quantity')?.querySelector('[data-unit-quantity]');
      if (!input) return;
      const { kind, productId, unitId } = input.dataset;
      const current = draftLines().find((line) => line.kind === kind && line.productId === productId && line.unitId === unitId)?.quantity || 0;
      setUnitQuantity(input, Math.max(0, current + Number(unitStep.dataset.unitStep)));
      return;
    }
    if (event.target.closest?.('#order-step-back')) { orderStep = Math.max(1, orderStep - 1); renderOrderStep(); return; }
    const editStep = event.target.closest?.('[data-edit-order-step]');
    if (editStep) { orderStep = Number(editStep.dataset.editOrderStep); renderOrderStep(); return; }
    const removeItem = event.target.closest?.('[data-remove-order-item]');
    if (removeItem) { $('order-lines')?.children[Number(removeItem.dataset.removeOrderItem)]?.remove(); renderProductPicker(); renderAddedItems(); return; }
    if (event.target.closest?.('[data-clear-order-items]')) { if (!globalThis.confirm || globalThis.confirm('Remove all added items?')) { $('order-lines').replaceChildren(); renderProductPicker(); renderAddedItems(); } return; }
    if (event.target.closest?.('#order-step-next')) {
      if (saving) return;
      const error = orderStep === 1 ? !$('order-customer')?.value ? 'Select a customer or add a new customer first.' : $('order-customer').value === '__new__' && !pendingCustomerDetails ? 'Finish entering the new customer.' : '' : draftError(draftLines());
      if (error) { $('order-form-error').textContent = error; $('order-form-error').hidden = false; return; }
      $('order-form-error').hidden = true;
      if (orderStep < 3) { orderStep++; renderOrderStep(); } else void submit({ preventDefault() {}, currentTarget: $('order-form') });
      return;
    }
    const quantityStep = event.target.closest?.('[data-quantity-step]');
    if (quantityStep) { const input = quantityStep.closest('label')?.querySelector('[name=quantity]'); const next = Math.max(1, Number(input?.value || 1) + Number(quantityStep.dataset.quantityStep)); if (input) { input.value = String(next); input.dispatchEvent(new Event('input', { bubbles: true })); } return; }
    const choice = event.target.closest?.('[data-customer-id]');
    if (choice) selectCustomer(choice.dataset.customerId);
    if (event.target.closest?.('#order-add-customer, #order-add-customer-empty') || ['order-add-customer', 'order-add-customer-empty'].includes(event.target.id)) openCustomerFromOrder();
    if (event.target.id === 'order-add-line') { $('order-lines').insertAdjacentHTML('beforeend', orderLine()); updateStockLabels(); }
    if (event.target.id === 'special-add-component' && $('special-components').children.length < 4) $('special-components').insertAdjacentHTML('beforeend', componentLine());
    if (event.target.matches('[data-remove-line]')) { const holder = event.target.closest('.ops-lines').querySelector('div[id]'); if (holder.children.length > (action === 'special' ? 2 : 1)) event.target.closest('.ops-line').remove(); }
  });
  $('order-form').addEventListener('submit', submit);
  $('order-dialog-close').addEventListener('click', closeOrderDialog);
  $('order-dialog-cancel').addEventListener('click', closeOrderDialog);
  $('order-dialog').addEventListener('cancel', (event) => {
    if (parkedOrder) { event.preventDefault(); restoreOrderForm(); return; }
    if (saving || action === 'order' && ($('order-customer')?.value || draftLines().length || $('order-fields').querySelector?.('[name=notes]')?.value?.trim()) && globalThis.confirm && !globalThis.confirm('Discard this order draft?')) event.preventDefault();
  });
  $('order-dialog').addEventListener('close', () => {
    stopOrderViewport(true);
    if (mobileNavigationParent && mobileNavigation?.parentNode === $('order-dialog')) {
      if (mobileNavigationNext?.parentNode === mobileNavigationParent) mobileNavigationParent.insertBefore(mobileNavigation, mobileNavigationNext);
      else mobileNavigationParent.appendChild(mobileNavigation);
      mobileNavigation.hidden = !profile;
    }
  });
  mobileNavigation?.addEventListener('click', (event) => {
    if (!$('order-dialog').open || !$('order-dialog').classList?.contains?.('order-create-mode') || !event.target.closest?.('[data-mobile-page]')) return;
    const hasDraft = $('order-customer')?.value || draftLines().length || $('order-fields').querySelector?.('[name=notes]')?.value?.trim();
    if (saving || hasDraft && globalThis.confirm && !globalThis.confirm('Discard this order draft?')) { event.preventDefault(); event.stopImmediatePropagation?.(); return; }
    $('order-dialog').close();
  }, true);
  $('customer-export').addEventListener('click', () => exportBook('customers', [['Customers', filteredCustomers().map((c) => ({ Name: c.fullName, Contact: c.contact, Address: c.address, Area: c.area, ...(staff() ? { DateOfBirth: c.dateOfBirth, Sabha: c.sabha } : {}) }))]]));
  $('order-export').addEventListener('click', () => {
    if (!ordersLoaded || !$('order-loading').hidden) return;
    const headers = ['Order', 'Customer', 'Date', 'Delivery date', 'Assigned user', 'Status', 'Archive', 'Total (INR)'];
    const values = filteredOrders().map((o) => [o.orderNumber, o.customerSnapshot?.fullName, o.orderDate, o.deliveryDate, assignedUserName(o), displayOrderStatus(o.status), o.archivedAt ? 'Archived' : 'Active', ((o.grandTotal || 0) / 100).toFixed(2)]);
    const cell = (value) => {
      const safe = String(value ?? '').replace(/^[\s\uFEFF]*[=+\-@]/, (match) => `'${match}`);
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = `\uFEFF${[headers, ...values].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('special-export').addEventListener('click', () => exportBook('specials', [['Special Products', filteredSpecials().map((s) => ({ Name: s.name, FinalPriceRupees: s.finalPricePaise / 100, Active: s.active, Components: s.components?.map((p) => `${p.itemSnapshot?.name}: ${qtyText(p.quantityQty)} ${p.itemSnapshot?.unitSymbol}`).join('; ') }))]]));

  return { setSession(nextUser, nextProfile) { sessionVersion++; activityRevision++; stopOrderInitialLoader(); stopActivityLoad(); for (const page of recordLoadTokens.keys()) stopRecordLoad(page); $('order-loading').hidden = true; orderRefreshPromise = null; ordersLoaded = false; user = nextUser; profile = nextProfile; orders = []; customers = []; items = []; specials = []; users = []; invoiceIds = new Set(); stockAvailability = new Map(); stockMessage = ''; activityRows = []; activityCursors = [null]; activityPage = 1; pendingOrderId = ''; pendingCustomerId = ''; pendingCustomerDetails = null; parkedOrder = null; appliedOrderFilters = blankOrderFilters(); writeOrderFilters(appliedOrderFilters); ['customer-body', 'order-body', 'special-body', 'customer-summary', 'order-cards', 'order-activity-body', 'order-activity-cards'].forEach((id) => { $(id).innerHTML = ''; }); $('order-user').hidden = !staff(); $('order-user-field').hidden = !staff(); $('order-active-filters').hidden = true; $('order-active-filters').innerHTML = ''; $('order-filter-pending').hidden = true; $('order-retry').hidden = true; $('order-export').disabled = true; if (profile) { const page = document.querySelector('[data-page].is-active')?.dataset.page; if (['customers', 'orders', 'specials'].includes(page)) refresh(page, page === 'orders'); } } };
}
