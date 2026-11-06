import { listDeliveries, listOrders } from './order-data.js';
import { deliveryStatistics, assignedDeliveryWorkload, deliveryOrderState } from './delivery-stats.js';
import { callOperation } from './operations-data.js';
import { uniqueId } from './unique-id.js';
import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { sortUsersByName } from './user-sort.js';
import { listMasterRecords } from './master-data.js';
import { cardIcon, cardButton } from './mobile-card.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const quantity = (value) => ((value || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateText = (value) => value?.toDate?.().toLocaleString('en-IN') || '';

export function initDeliveryUi({ db, functions }) {
  let user = null, profile = null, records = [], orders = [], users = [], currentOrder = null, currentRecord = null, rollbackRecord = null, submissionId = '', saving = false, rollbackSaving = false, loadVersion = 0;
  const ids = ['delivery-search', 'delivery-user', 'delivery-status', 'delivery-customer', 'delivery-from', 'delivery-to', 'delivery-order', 'delivery-item'];
  const filters = () => Object.fromEntries(ids.map((id) => [id, $(id).value.trim()]));
  let applied = {};
  let pendingUserId = '';
  const assignedName = (record) => record.assignedUserName || record.assignedUserId || 'Unknown';
  const deliveredQuantity = (record) => { const lines = record.lines || []; const units = [...new Set(lines.map((line) => line.unit).filter(Boolean))]; return `${quantity(lines.reduce((sum, line) => sum + (line.deliveredQty || 0), 0))}${units.length === 1 ? ` ${units[0]}` : ''}`; };
  const dayOf = (record) => {
    const delivered = record.deliveredAt?.toDate?.();
    return delivered ? `${delivered.getFullYear()}-${String(delivered.getMonth() + 1).padStart(2, '0')}-${String(delivered.getDate()).padStart(2, '0')}` : '';
  };
  function renderStats(selectedOrders) {
    const stats = deliveryStatistics(selectedOrders, records);
    const cards = [
      ['Order Delivered', stats.deliveredOrders, 'Orders', stats.deliveredOrderPercent, 'delivered', '✓'],
      ['Order Pending', stats.pendingOrders, 'Orders', stats.pendingOrderPercent, 'pending', '◷'],
      ['KG Delivered', stats.deliveredKg, 'KG', stats.deliveredKgPercent, 'delivered', '✓'],
      ['KG Pending', stats.pendingKg, 'KG', stats.pendingKgPercent, 'pending', '◷'],
    ];
    $('delivery-stats').innerHTML = cards.map(([title, value, unit, share, tone, icon]) => `<article class="delivery-stat-card is-${tone}"><div class="delivery-stat-heading"><span>${title}</span><span class="delivery-stat-icon" aria-hidden="true">${icon}</span></div><strong>${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 })} <small>${unit}</small></strong><span class="delivery-stat-percent">${share.toFixed(2)}% of total</span><div class="delivery-stat-track" role="progressbar" aria-label="${title}" aria-valuenow="${share.toFixed(2)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${share.toFixed(2)}%"></span></div></article>`).join('');
  }
  function render() {
    const f = applied;
    const names = new Map(users.map((row) => [row.id, row.displayName || row.fullName || row.id]));
    for (const record of records) if (!names.has(record.assignedUserId)) names.set(record.assignedUserId, assignedName(record));
    const workload = assignedDeliveryWorkload(orders, records, names);
    $('delivery-users-section').hidden = !isStaff(profile) || !workload.length;
    const sortedWorkload = [...workload].sort((a, b) => b.pendingOrders - a.pendingOrders || b.pendingKg - a.pendingKg || a.userName.localeCompare(b.userName));
    $('delivery-users').innerHTML = `<table class="delivery-users-table"><thead><tr><th scope="col">Assigned User</th><th scope="col">Pending Orders</th><th scope="col">Pending KG</th><th scope="col">Delivered Orders</th><th scope="col">Delivered KG</th><th scope="col">Completion</th><th scope="col">Action</th></tr></thead><tbody>${sortedWorkload.map((group) => `<tr><th scope="row">${esc(group.userName)}</th><td>${group.pendingOrders}</td><td>${esc(group.pendingKg.toLocaleString('en-IN', { maximumFractionDigits: 3 }))} KG</td><td>${group.deliveredOrders}</td><td>${esc(group.deliveredKg.toLocaleString('en-IN', { maximumFractionDigits: 3 }))} KG</td><td><span class="delivery-user-progress-label">${group.progress.toFixed(0)}%</span><span class="delivery-user-progress-track" role="progressbar" aria-label="${esc(group.userName)} completion" aria-valuenow="${group.progress.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${group.progress.toFixed(2)}%"></span></span></td><td><button type="button" class="ops-link" data-pending-user="${esc(group.userId)}" aria-label="View pending orders for ${esc(group.userName)}">View Pending →</button></td></tr>`).join('')}</tbody></table>`;
    const recordRows = records.filter((record) => {
      const day = dayOf(record);
      const search = f['delivery-search']?.toLowerCase();
      return (!search || `${record.deliveryNumber} ${record.orderNumber} ${record.customerSnapshot?.fullName}`.toLowerCase().includes(search))
        && (!f['delivery-user'] || record.assignedUserId === f['delivery-user'])
        && (!f['delivery-customer'] || record.customerId === f['delivery-customer'])
        && (!f['delivery-from'] || day >= f['delivery-from']) && (!f['delivery-to'] || day <= f['delivery-to'])
        && (!f['delivery-order'] || record.orderNumber?.toLowerCase().includes(f['delivery-order'].toLowerCase()))
        && (!f['delivery-item'] || record.lines?.some((line) => line.name?.toLowerCase().includes(f['delivery-item'].toLowerCase())));
    }).sort((a, b) => (b.deliveredAt?.seconds || 0) - (a.deliveredAt?.seconds || 0));
    const matchingRecordOrders = new Set(recordRows.map((record) => record.orderId));
    const selectedOrders = orders.filter((order) => {
      const search = f['delivery-search']?.toLowerCase();
      const itemNames = (order.lines || []).map((line) => line.kind === 'special' ? line.specialSnapshot?.name : line.itemSnapshot?.name).join(' ').toLowerCase();
      const matches = (!search || `${order.orderNumber} ${order.customerSnapshot?.fullName}`.toLowerCase().includes(search) || matchingRecordOrders.has(order.id))
        && (!f['delivery-user'] || order.assignedUserId === f['delivery-user'])
        && (!f['delivery-customer'] || order.customerId === f['delivery-customer'])
        && (!f['delivery-order'] || order.orderNumber?.toLowerCase().includes(f['delivery-order'].toLowerCase()))
        && (!f['delivery-item'] || itemNames.includes(f['delivery-item'].toLowerCase()));
      const day = order.deliveryDate || order.orderDate || '';
      const dateMatches = (!f['delivery-from'] || day >= f['delivery-from']) && (!f['delivery-to'] || day <= f['delivery-to']);
      return matches && ((f['delivery-status'] && f['delivery-status'] !== 'rolled_back') || pendingUserId ? dateMatches : matchingRecordOrders.has(order.id) || dateMatches);
    });
    const orderRow = (order) => ({ id: order.id, kind: 'order', orderId: order.id, orderNumber: order.orderNumber, customerId: order.customerId, customerSnapshot: order.customerSnapshot, assignedUserId: order.assignedUserId, assignedUserName: users.find((entry) => entry.id === order.assignedUserId)?.displayName || order.assignedUserName || order.assignedUserId, orderDate: order.deliveryDate || order.orderDate, orderStatus: deliveryOrderState(order, records), pendingKg: deliveryStatistics([order], records).pendingKg });
    const rows = f['delivery-status'] === 'rolled_back' ? recordRows.filter((record) => record.status === 'rolled_back' || record.rolledBackAt)
      : f['delivery-status'] || pendingUserId ? selectedOrders.filter((order) => {
        const status = deliveryOrderState(order, records);
        return f['delivery-status'] === 'pending' || pendingUserId && !f['delivery-status'] ? ['pending', 'partial'].includes(status) : status === f['delivery-status'];
      }).map(orderRow) : recordRows;
    renderStats(selectedOrders);
    const selectedGroup = workload.find((group) => group.userId === pendingUserId);
    const pendingRows = selectedGroup?.pending.filter(({ order }) => selectedOrders.some((row) => row.id === order.id)) || [];
    $('delivery-pending-section').hidden = !pendingUserId;
    $('delivery-pending-title').textContent = `Pending orders · ${selectedGroup?.userName || 'Assigned user'}`;
    $('delivery-pending-orders').innerHTML = pendingRows.length ? `<div class="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Pending KG</th><th>Status</th></tr></thead><tbody>${pendingRows.map(({ order, pendingKg, status }) => `<tr><td>${esc(order.orderNumber)}</td><td>${esc(order.customerSnapshot?.fullName)}</td><td>${esc(pendingKg.toLocaleString('en-IN', { maximumFractionDigits: 3 }))} KG</td><td>${status}</td></tr>`).join('')}</tbody></table></div>` : '<p>No pending orders match the current filters.</p>';
    const showPendingBack = Boolean(f['delivery-user'] && (pendingUserId || f['delivery-status'] === 'pending'));
    $('delivery-pending-nav').hidden = !showPendingBack;
    $('delivery-pending-context').textContent = showPendingBack ? `Showing pending deliveries assigned to ${names.get(f['delivery-user']) || selectedGroup?.userName || 'selected user'}` : '';
    $('delivery-count').textContent = `${rows.length} ${(f['delivery-status'] && f['delivery-status'] !== 'rolled_back') || pendingUserId ? 'order' : 'delivery record'}${rows.length === 1 ? '' : 's'}`;
    const filtered = Object.values(applied).some(Boolean);
    $('delivery-empty').hidden = rows.length > 0;
    $('delivery-empty-description').textContent = filtered ? 'No deliveries match the current filters.' : 'Deliveries will appear here once orders are delivered.';
    $('delivery-empty-clear').hidden = !filtered;
    $('delivery-table').hidden = rows.length === 0;
    $('delivery-mobile-list').hidden = rows.length === 0;
    $('delivery-head').innerHTML = '<th>Delivery</th><th>Date</th><th>Order</th><th>Customer</th><th>Assigned Karyakarta</th><th>Delivered by</th><th>Quantity</th><th>Status</th>' + (f['delivery-status'] === 'rolled_back' ? '<th>Rolled Back Date</th><th>Rolled Back By</th><th>Reason</th>' : '') + '<th>Actions</th>';
    $('delivery-body').innerHTML = rows.length ? rows.map((record) => {
      const rolled = record.status === 'rolled_back' || record.rolledBackAt;
      const rollbackAllowed = profile?.role === 'admin' && !rolled && record.kind !== 'order' && orders.some((order) => order.id === record.orderId && order.status !== 'cancelled' && !order.archivedAt);
      const status = record.kind === 'order' ? ({ pending: 'Pending', partial: 'Partially Delivered', delivered: 'Delivered' })[record.orderStatus] : rolled ? 'Rolled Back' : record.complete ? 'Delivered' : 'Partially Delivered';
      const quantityText = record.kind === 'order' ? `${record.pendingKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG pending` : quantity(record.lines?.reduce((sum, line) => sum + line.deliveredQty, 0));
      const action = record.kind === 'order' ? `<button type="button" class="ops-link" data-order-number="${esc(record.orderNumber)}">View order</button>` : `<button type="button" class="ops-link" data-delivery-id="${esc(record.id)}">View</button>${rollbackAllowed ? ` <button type="button" class="button button-danger delivery-rollback-action" data-rollback-id="${esc(record.id)}">Rollback</button>` : ''}`;
      return `<tr><td>${esc(record.deliveryNumber || '—')}</td><td>${esc(record.kind === 'order' ? record.orderDate || '—' : dateText(record.deliveredAt))}</td><td>${esc(record.orderNumber)}</td><td>${esc(record.customerSnapshot?.fullName)}</td><td>${esc(assignedName(record))}</td><td>${esc(record.deliveredByName || record.deliveredBy || '—')}</td><td>${esc(quantityText)}</td><td><span class="delivery-status-badge${rolled ? ' is-rolled-back' : ''}">${status}</span></td>${f['delivery-status'] === 'rolled_back' ? `<td>${esc(dateText(record.rolledBackAt))}</td><td>${esc(record.rolledBackByName || record.rolledBackBy || '')}</td><td class="delivery-rollback-reason">${esc(record.rollbackReason || '')}</td>` : ''}<td>${action}</td></tr>`;
    }).join('') : `<tr><td colspan="${f['delivery-status'] === 'rolled_back' ? 12 : 9}" class="empty-cell">No deliveries match these filters.</td></tr>`;
    $('delivery-mobile-list').innerHTML = rows.map((record) => {
      const rolled = record.status === 'rolled_back' || record.rolledBackAt;
      const rollbackAllowed = profile?.role === 'admin' && !rolled && record.kind !== 'order' && orders.some((order) => order.id === record.orderId && order.status !== 'cancelled' && !order.archivedAt);
      const status = record.kind === 'order' ? ({ pending: 'Pending', partial: 'Partially Delivered', delivered: 'Delivered' })[record.orderStatus] : rolled ? 'Rolled Back' : record.complete ? 'Delivered' : 'Partially Delivered';
      const quantityText = record.kind === 'order' ? `${record.pendingKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG pending` : deliveredQuantity(record);
      return `<article class="order-mobile-card"><div class="order-card-header"><strong>${esc(record.deliveryNumber || record.orderNumber || 'Delivery unavailable')}</strong><span class="mobile-status is-${rolled ? 'rejected' : status === 'Delivered' ? 'verified' : 'pending'}">${status}</span></div><h3 class="order-card-customer">${esc(record.customerSnapshot?.fullName || 'Customer unavailable')}</h3><div class="order-card-meta"><span>${cardIcon('calendar')}${esc(record.kind === 'order' ? record.orderDate || 'Date unavailable' : dateText(record.deliveredAt))}</span><span>${cardIcon('user')}${esc(assignedName(record))}</span></div><div class="order-card-total"><span>Order: ${esc(record.orderNumber)}</span><strong>${esc(quantityText)}</strong></div>${rolled ? `<p class="mobile-card-note">Rolled back ${esc(dateText(record.rolledBackAt))} by ${esc(record.rolledBackByName || record.rolledBackBy || '')}. Reason: ${esc(record.rollbackReason || '')}</p>` : ''}<div class="order-card-actions">${record.kind === 'order' ? cardButton('order', record.id, 'View order', 'order', 'data-delivery-action') : cardButton('view', record.id, 'View delivery', 'view', 'data-delivery-action') + cardButton('order', record.id, 'View order', 'order', 'data-delivery-action')}${rollbackAllowed ? `<button type="button" class="button button-danger" data-delivery-action="rollback" data-id="${esc(record.id)}">Rollback</button>` : ''}</div></article>`;
    }).join('');
  }
  async function refresh() {
    if (!user || !profile) return;
    const version = ++loadVersion;
    const loadToken = globalThis.omsLoading?.start('Loading deliveries…');
    $('delivery-loading').hidden = false;
    $('delivery-error').hidden = true;
    $('delivery-empty').hidden = true;
    $('delivery-table').hidden = true;
    $('delivery-mobile-list').hidden = true;
    $('delivery-count').textContent = '';
    try {
      const owner = isStaff(profile) ? null : user.uid;
      const [rows, orderRows, userRows] = await Promise.all([listDeliveries(db, owner), listOrders(db, owner), isStaff(profile) ? listMasterRecords(db, 'users') : Promise.resolve([])]);
      if (version !== loadVersion) return;
      records = rows; orders = orderRows; users = userRows;
      const selectedUser = $('delivery-user').value, selectedCustomer = $('delivery-customer').value;
      const userOptions = sortUsersByName([...new Map([...rows.map((row) => [row.assignedUserId, assignedName(row)]), ...orderRows.map((row) => [row.assignedUserId, users.find((user) => user.id === row.assignedUserId)?.displayName || users.find((user) => user.id === row.assignedUserId)?.fullName || row.assignedUserName || row.assignedUserId])]).entries()].filter(([id]) => id).map(([id, name]) => ({ id, name })));
      $('delivery-user').innerHTML = '<option value="">All users</option>' + userOptions.map(({ id, name }) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      $('delivery-user').value = userOptions.some(({ id }) => id === selectedUser) ? selectedUser : '';
      const customers = [...new Map([...rows, ...orderRows].map((row) => [row.customerId, row.customerSnapshot?.fullName])).entries()].filter(([id]) => id);
      $('delivery-customer').innerHTML = '<option value="">All customers</option>' + customers.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      $('delivery-customer').value = customers.some(([id]) => id === selectedCustomer) ? selectedCustomer : '';
      render();
    } catch (error) { if (version === loadVersion) { records = []; orders = []; renderStats([]); $('delivery-error-message').textContent = error.message || 'Please try again.'; $('delivery-error').hidden = false; $('delivery-count').textContent = ''; } }
    finally { globalThis.omsLoading?.stop(loadToken); if (version === loadVersion) $('delivery-loading').hidden = true; }
  }
  function openRecord(record) {
    currentOrder = null; currentRecord = record;
    $('delivery-title').textContent = record.deliveryNumber;
    $('delivery-save').hidden = true;
    $('delivery-content').innerHTML = `<p><strong>Order:</strong> ${esc(record.orderNumber)} · <strong>Customer:</strong> ${esc(record.customerSnapshot?.fullName)}</p><p><strong>Contact:</strong> ${esc(record.customerSnapshot?.contact || '')} · <strong>Assigned:</strong> ${esc(assignedName(record))}</p><p><strong>Delivered:</strong> ${esc(dateText(record.deliveredAt))} · <strong>By:</strong> ${esc(record.deliveredByName || record.deliveredBy)}</p>${record.status === 'rolled_back' || record.rolledBackAt ? `<p class="delivery-rolled-back-note"><strong>Rolled Back:</strong> ${esc(dateText(record.rolledBackAt))} · <strong>By:</strong> ${esc(record.rolledBackByName || record.rolledBackBy || '')}<br><strong>Reason:</strong> ${esc(record.rollbackReason || '')}</p>` : ''}<div class="table-scroll"><table><thead><tr><th>Item</th><th>Ordered Qty</th><th>Delivered Qty</th><th>Unit</th></tr></thead><tbody>${record.lines.map((line) => `<tr><td>${esc(line.name)}</td><td>${esc(quantity(line.orderedQty))}</td><td>${esc(quantity(line.deliveredQty))}</td><td>${esc(line.unit)}</td></tr>`).join('')}</tbody></table></div><p><strong>Remarks:</strong> ${esc(record.remarks || 'None')}</p><button type="button" class="button button-outline" id="delivery-back">Back to Deliveries</button>`;
    $('delivery-dialog').showModal();
  }
  function openCreate(order) {
    if (!user || !profile) return;
    currentRecord = null; currentOrder = order; submissionId = uniqueId();
    const history = records.filter((record) => record.orderId === order.id && record.status !== 'rolled_back' && !record.rolledBackAt);
    $('delivery-title').textContent = `Create Delivery · ${order.orderNumber}`;
    $('delivery-save').hidden = false;
    $('delivery-content').innerHTML = `<p><strong>Customer:</strong> ${esc(order.customerSnapshot?.fullName)} · <strong>Order:</strong> ${esc(order.orderNumber)}</p><p>Actual delivery date and time and delivered by are recorded when saved.</p><div class="table-scroll"><table><thead><tr><th>Item</th><th>Ordered</th><th>Remaining</th><th>Deliver now</th><th>Unit</th></tr></thead><tbody>${(order.lines || []).map((line, index) => { const used = history.reduce((sum, record) => sum + (record.lines?.[index]?.deliveredQty || 0), 0); const remaining = Math.max(0, line.quantityQty - used); return `<tr><td>${esc(line.kind === 'special' ? line.specialSnapshot?.name : line.itemSnapshot?.name)}</td><td>${esc(quantity(line.quantityQty))}</td><td>${esc(quantity(remaining))}</td><td><input type="number" name="quantity-${index}" min="0" max="${remaining / 1000}" step="0.001" value="${remaining / 1000}" required aria-label="Delivered quantity for item ${index + 1}"></td><td>${esc(line.kind === 'special' ? 'combo' : line.orderUnitName || line.itemSnapshot?.unitSymbol)}</td></tr>`; }).join('')}</tbody></table></div><label class="ops-field">Remarks (optional)<textarea name="remarks" maxlength="1000"></textarea></label>`;
    $('delivery-error').hidden = true;
    $('delivery-dialog').showModal();
  }
  $('delivery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentOrder || saving) return;
    const data = new FormData(event.currentTarget);
    const lines = currentOrder.lines.map((_, index) => ({ deliveredQty: Math.round(Number(data.get(`quantity-${index}`)) * 1000) }));
    if (!lines.some((line) => line.deliveredQty > 0)) { $('delivery-error').textContent = 'Deliver at least one item.'; $('delivery-error').hidden = false; return; }
    if (!globalThis.confirm(`Record delivery for ${currentOrder.orderNumber}?`)) return;
    saving = true; $('delivery-save').disabled = true;
    try {
      const result = await callOperation(functions, 'createDelivery', { orderId: currentOrder.id, submissionId, lines, remarks: data.get('remarks') || '' });
      $('delivery-dialog').close(); showToast(`${result.deliveryNumber} recorded.`); await refresh();
      document.dispatchEvent(new CustomEvent('oms:deliverycreated', { detail: { orderId: currentOrder.id } }));
    } catch (error) { $('delivery-error').textContent = error.message; $('delivery-error').hidden = false; }
    finally { saving = false; $('delivery-save').disabled = false; }
  });
  $('delivery-close').addEventListener('click', () => $('delivery-dialog').close());
  $('delivery-cancel').addEventListener('click', () => $('delivery-dialog').close());
  $('delivery-content').addEventListener('click', (event) => { if (event.target.id === 'delivery-back') { $('delivery-dialog').close(); document.querySelector('[data-page="deliveries"]')?.click(); } });
  const viewOrder = (number) => { document.querySelector('[data-page="orders"]')?.click(); $('order-search').value = number || ''; $('order-apply').click(); };
  const openRollback = (record) => {
    if (profile?.role !== 'admin' || !record || record.status === 'rolled_back' || record.rolledBackAt) return;
    rollbackRecord = record;
    $('delivery-rollback-form').reset();
    $('delivery-rollback-error').hidden = true;
    $('delivery-rollback-details').innerHTML = `<p>You are about to reverse this delivery. Its original record will remain in history.</p><dl class="delivery-rollback-summary"><div><dt>Order</dt><dd>${esc(record.orderNumber)}</dd></div><div><dt>Customer</dt><dd>${esc(record.customerSnapshot?.fullName)}</dd></div><div><dt>Assigned To</dt><dd>${esc(assignedName(record))}</dd></div><div><dt>Delivered</dt><dd>${esc(dateText(record.deliveredAt))}</dd></div></dl><div class="table-scroll"><table><thead><tr><th>Item</th><th>Delivered quantity</th><th>Unit</th></tr></thead><tbody>${(record.lines || []).map((line) => `<tr><td>${esc(line.name)}</td><td>${esc(quantity(line.deliveredQty))}</td><td>${esc(line.unit)}</td></tr>`).join('')}</tbody></table></div>`;
    $('delivery-rollback-dialog').showModal();
  };
  document.addEventListener('oms:rollbackdelivery', (event) => {
    const record = records.find((row) => row.id === event.detail?.deliveryId);
    if (record) openRollback(record);
  });
  $('delivery-body').addEventListener('click', (event) => { const rollbackId = event.target.closest('[data-rollback-id]')?.dataset.rollbackId; if (rollbackId) return openRollback(records.find((record) => record.id === rollbackId)); const id = event.target.closest('[data-delivery-id]')?.dataset.deliveryId; if (id) return openRecord(records.find((record) => record.id === id)); const orderNumber = event.target.closest('[data-order-number]')?.dataset.orderNumber; if (orderNumber) viewOrder(orderNumber); });
  $('delivery-mobile-list').addEventListener('click', (event) => { const button = event.target.closest('[data-delivery-action]'); if (!button) return; const record = records.find((row) => row.id === button.dataset.id); if (button.dataset.deliveryAction === 'rollback') return openRollback(record); if (button.dataset.deliveryAction === 'view' && record) return openRecord(record); viewOrder(record?.orderNumber || orders.find((row) => row.id === button.dataset.id)?.orderNumber); });
  $('delivery-rollback-close').addEventListener('click', () => $('delivery-rollback-dialog').close());
  $('delivery-rollback-cancel').addEventListener('click', () => $('delivery-rollback-dialog').close());
  $('delivery-rollback-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!rollbackRecord || rollbackSaving) return;
    const reason = String(new FormData(event.currentTarget).get('reason') || '').trim();
    if (!reason) { $('delivery-rollback-error').textContent = 'Enter a reason for rollback.'; $('delivery-rollback-error').hidden = false; return; }
    rollbackSaving = true; $('delivery-rollback-save').disabled = true; $('delivery-rollback-error').hidden = true;
    try {
      const deliveryId = rollbackRecord.id, orderId = rollbackRecord.orderId;
      await callOperation(functions, 'rollbackDelivery', { deliveryId, reason });
      $('delivery-rollback-dialog').close(); rollbackRecord = null;
      showToast('Delivery rolled back.'); await refresh();
      document.dispatchEvent(new CustomEvent('oms:deliverycreated', { detail: { orderId } }));
    } catch (error) { $('delivery-rollback-error').textContent = error.message || 'Rollback failed. Try again.'; $('delivery-rollback-error').hidden = false; }
    finally { rollbackSaving = false; $('delivery-rollback-save').disabled = false; }
  });
  $('delivery-filters').addEventListener('submit', (event) => { event.preventDefault(); applied = filters(); if (applied['delivery-status']) pendingUserId = ''; render(); });
  $('delivery-users').addEventListener('click', (event) => { const id = event.target.closest('[data-pending-user]')?.dataset.pendingUser; if (!id) return; pendingUserId = id; $('delivery-user').value = id; $('delivery-status').value = 'pending'; applied = { ...filters(), 'delivery-user': id, 'delivery-status': 'pending' }; render(); $('delivery-pending-nav').scrollIntoView?.({ block: 'nearest' }); });
  $('delivery-back-all-pending').addEventListener('click', () => { pendingUserId = ''; $('delivery-user').value = ''; $('delivery-status').value = 'pending'; applied = { ...applied, 'delivery-user': '', 'delivery-status': 'pending' }; render(); });
  $('delivery-clear').addEventListener('click', () => { ids.forEach((id) => { $(id).value = ''; }); applied = {}; pendingUserId = ''; render(); });
  $('delivery-empty-clear').addEventListener('click', () => { const mobileClear = document.querySelector('#deliveries-view .mobile-filter-sheet .mobile-filter-clear'); if (mobileClear && matchMedia('(max-width: 760px)').matches) mobileClear.click(); else $('delivery-clear').click(); });
  $('delivery-refresh').addEventListener('click', refresh);
  $('delivery-retry').addEventListener('click', refresh);
  document.addEventListener('oms:pagechange', (event) => { if (event.detail?.page === 'deliveries') refresh(); });
  document.addEventListener('oms:createdelivery', async (event) => { await refresh(); openCreate(event.detail.order); });
  return { setSession(nextUser, nextProfile) { loadVersion++; user = nextUser; profile = nextProfile; records = []; orders = []; currentOrder = null; applied = {}; pendingUserId = ''; ids.forEach((id) => { $(id).value = ''; }); $('delivery-body').innerHTML = ''; $('delivery-mobile-list').innerHTML = ''; $('delivery-count').textContent = ''; $('delivery-stats').innerHTML = ''; $('delivery-users').innerHTML = ''; $('delivery-users-section').hidden = true; $('delivery-pending-section').hidden = true; $('delivery-pending-nav').hidden = true; $('delivery-table').hidden = true; $('delivery-mobile-list').hidden = true; $('delivery-empty').hidden = true; $('delivery-error').hidden = true; $('delivery-loading').hidden = true; if (profile && document.querySelector('[data-page="deliveries"].is-active')) refresh(); } };
}
