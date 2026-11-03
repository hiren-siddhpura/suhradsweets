import { listDeliveries, listOrders } from './order-data.js';
import { deliveryStatistics } from './delivery-stats.js';
import { callOperation } from './operations-data.js';
import { uniqueId } from './unique-id.js';
import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { sortUsersByName } from './user-sort.js';
import { cardIcon, cardButton } from './mobile-card.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const quantity = (value) => ((value || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateText = (value) => value?.toDate?.().toLocaleString('en-IN') || '';

export function initDeliveryUi({ db, functions }) {
  let user = null, profile = null, records = [], orders = [], currentOrder = null, currentRecord = null, submissionId = '', saving = false, loadVersion = 0;
  const ids = ['delivery-search', 'delivery-user', 'delivery-customer', 'delivery-from', 'delivery-to', 'delivery-order', 'delivery-item'];
  const filters = () => Object.fromEntries(ids.map((id) => [id, $(id).value.trim()]));
  let applied = {};
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
    const rows = records.filter((record) => {
      const day = dayOf(record);
      const search = f['delivery-search']?.toLowerCase();
      return (!search || `${record.deliveryNumber} ${record.orderNumber} ${record.customerSnapshot?.fullName}`.toLowerCase().includes(search))
        && (!f['delivery-user'] || record.assignedUserId === f['delivery-user'])
        && (!f['delivery-customer'] || record.customerId === f['delivery-customer'])
        && (!f['delivery-from'] || day >= f['delivery-from']) && (!f['delivery-to'] || day <= f['delivery-to'])
        && (!f['delivery-order'] || record.orderNumber?.toLowerCase().includes(f['delivery-order'].toLowerCase()))
        && (!f['delivery-item'] || record.lines?.some((line) => line.name?.toLowerCase().includes(f['delivery-item'].toLowerCase())));
    }).sort((a, b) => (b.deliveredAt?.seconds || 0) - (a.deliveredAt?.seconds || 0));
    const matchingRecordOrders = new Set(rows.map((record) => record.orderId));
    const selectedOrders = orders.filter((order) => {
      const search = f['delivery-search']?.toLowerCase();
      const itemNames = (order.lines || []).map((line) => line.kind === 'special' ? line.specialSnapshot?.name : line.itemSnapshot?.name).join(' ').toLowerCase();
      const matches = (!search || `${order.orderNumber} ${order.customerSnapshot?.fullName}`.toLowerCase().includes(search) || matchingRecordOrders.has(order.id))
        && (!f['delivery-user'] || (order.assignedUserId || order.ownerUid) === f['delivery-user'])
        && (!f['delivery-customer'] || order.customerId === f['delivery-customer'])
        && (!f['delivery-order'] || order.orderNumber?.toLowerCase().includes(f['delivery-order'].toLowerCase()))
        && (!f['delivery-item'] || itemNames.includes(f['delivery-item'].toLowerCase()));
      const day = order.deliveryDate || order.orderDate || '';
      const dateMatches = (!f['delivery-from'] || day >= f['delivery-from']) && (!f['delivery-to'] || day <= f['delivery-to']);
      return matches && (matchingRecordOrders.has(order.id) || dateMatches);
    });
    renderStats(selectedOrders);
    $('delivery-count').textContent = `${rows.length} delivery record${rows.length === 1 ? '' : 's'}`;
    const filtered = Object.values(applied).some(Boolean);
    $('delivery-empty').hidden = rows.length > 0;
    $('delivery-empty-description').textContent = filtered ? 'No deliveries match the current filters.' : 'Deliveries will appear here once orders are delivered.';
    $('delivery-empty-clear').hidden = !filtered;
    $('delivery-table').hidden = rows.length === 0;
    $('delivery-mobile-list').hidden = rows.length === 0;
    $('delivery-body').innerHTML = rows.length ? rows.map((record) => `<tr><td>${esc(record.deliveryNumber)}</td><td>${esc(dateText(record.deliveredAt))}</td><td>${esc(record.orderNumber)}</td><td>${esc(record.customerSnapshot?.fullName)}</td><td>${esc(assignedName(record))}</td><td>${esc(record.deliveredByName || record.deliveredBy)}</td><td>${esc(quantity(record.lines?.reduce((sum, line) => sum + line.deliveredQty, 0)))}</td><td>${record.complete ? 'Complete' : 'Partial'}</td><td><button type="button" class="ops-link" data-delivery-id="${esc(record.id)}">View</button></td></tr>`).join('') : '<tr><td colspan="9" class="empty-cell">No deliveries match these filters.</td></tr>';
    $('delivery-mobile-list').innerHTML = rows.map((record) => `<article class="order-mobile-card"><div class="order-card-header"><strong>${esc(record.deliveryNumber || 'Delivery number unavailable')}</strong><span class="mobile-status is-${record.complete ? 'verified' : 'pending'}">${record.complete ? 'Delivered' : 'Partial'}</span></div><h3 class="order-card-customer">${esc(record.customerSnapshot?.fullName || 'Customer unavailable')}</h3><div class="order-card-meta"><span>${cardIcon('calendar')}${esc(dateText(record.deliveredAt))}</span><span>${cardIcon('user')}${esc(assignedName(record))}</span></div><div class="order-card-total"><span>Order: ${esc(record.orderNumber)}</span><strong>${esc(deliveredQuantity(record))}</strong></div><div class="order-card-actions">${cardButton('view', record.id, 'View delivery', 'view', 'data-delivery-action')}${cardButton('order', record.id, 'View order', 'order', 'data-delivery-action')}</div></article>`).join('');
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
      const [rows, orderRows] = await Promise.all([listDeliveries(db, owner), listOrders(db, owner)]);
      if (version !== loadVersion) return;
      records = rows; orders = orderRows;
      const selectedUser = $('delivery-user').value, selectedCustomer = $('delivery-customer').value;
      const userOptions = sortUsersByName([...new Map(rows.map((row) => [row.assignedUserId, assignedName(row)])).entries()].filter(([id]) => id).map(([id, name]) => ({ id, name })));
      $('delivery-user').innerHTML = '<option value="">All users</option>' + userOptions.map(({ id, name }) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      $('delivery-user').value = userOptions.some(({ id }) => id === selectedUser) ? selectedUser : '';
      const customers = [...new Map(rows.map((row) => [row.customerId, row.customerSnapshot?.fullName])).entries()].filter(([id]) => id);
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
    $('delivery-content').innerHTML = `<p><strong>Order:</strong> ${esc(record.orderNumber)} · <strong>Customer:</strong> ${esc(record.customerSnapshot?.fullName)}</p><p><strong>Contact:</strong> ${esc(record.customerSnapshot?.contact || '')} · <strong>Assigned:</strong> ${esc(assignedName(record))}</p><p><strong>Delivered:</strong> ${esc(dateText(record.deliveredAt))} · <strong>By:</strong> ${esc(record.deliveredByName || record.deliveredBy)}</p><div class="table-scroll"><table><thead><tr><th>Item</th><th>Ordered Qty</th><th>Delivered Qty</th><th>Unit</th></tr></thead><tbody>${record.lines.map((line) => `<tr><td>${esc(line.name)}</td><td>${esc(quantity(line.orderedQty))}</td><td>${esc(quantity(line.deliveredQty))}</td><td>${esc(line.unit)}</td></tr>`).join('')}</tbody></table></div><p><strong>Remarks:</strong> ${esc(record.remarks || 'None')}</p><button type="button" class="button button-outline" id="delivery-back">Back to Deliveries</button>`;
    $('delivery-dialog').showModal();
  }
  function openCreate(order) {
    if (!user || !profile) return;
    currentRecord = null; currentOrder = order; submissionId = uniqueId();
    const history = records.filter((record) => record.orderId === order.id);
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
  $('delivery-body').addEventListener('click', (event) => { const id = event.target.closest('[data-delivery-id]')?.dataset.deliveryId; if (id) openRecord(records.find((record) => record.id === id)); });
  $('delivery-mobile-list').addEventListener('click', (event) => { const button = event.target.closest('[data-delivery-action]'); if (!button) return; const record = records.find((row) => row.id === button.dataset.id); if (!record) return; if (button.dataset.deliveryAction === 'view') openRecord(record); else { document.querySelector('[data-page="orders"]')?.click(); $('order-search').value = record.orderNumber || ''; $('order-apply').click(); } });
  $('delivery-filters').addEventListener('submit', (event) => { event.preventDefault(); applied = filters(); render(); });
  $('delivery-clear').addEventListener('click', () => { ids.forEach((id) => { $(id).value = ''; }); applied = {}; render(); });
  $('delivery-empty-clear').addEventListener('click', () => { const mobileClear = document.querySelector('#deliveries-view .mobile-filter-sheet .mobile-filter-clear'); if (mobileClear && matchMedia('(max-width: 760px)').matches) mobileClear.click(); else $('delivery-clear').click(); });
  $('delivery-refresh').addEventListener('click', refresh);
  $('delivery-retry').addEventListener('click', refresh);
  document.addEventListener('oms:pagechange', (event) => { if (event.detail?.page === 'deliveries') refresh(); });
  document.addEventListener('oms:createdelivery', async (event) => { await refresh(); openCreate(event.detail.order); });
  return { setSession(nextUser, nextProfile) { loadVersion++; user = nextUser; profile = nextProfile; records = []; orders = []; currentOrder = null; applied = {}; ids.forEach((id) => { $(id).value = ''; }); $('delivery-body').innerHTML = ''; $('delivery-mobile-list').innerHTML = ''; $('delivery-count').textContent = ''; $('delivery-stats').innerHTML = ''; $('delivery-table').hidden = true; $('delivery-mobile-list').hidden = true; $('delivery-empty').hidden = true; $('delivery-error').hidden = true; $('delivery-loading').hidden = true; if (profile && document.querySelector('[data-page="deliveries"].is-active')) refresh(); } };
}
