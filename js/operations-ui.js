import { hasPermission, isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { listMasterRecords } from './master-data.js';
import { callOperation, listInventory, listMovements, listPurchases } from './operations-data.js';
import { downloadXlsx } from './xlsx-export.js';
import { uniqueId } from './unique-id.js';

const byId = (id) => document.getElementById(id);
const escaped = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shownQty = (value) => ((value || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateOf = (value) => value?.toDate ? value.toDate().toLocaleString('en-IN') : '';
const empty = (columns, message) => `<tr><td colspan="${columns}" class="empty-cell">${escaped(message)}</td></tr>`;
const safeError = (error) => error?.message?.replace(/^.*?: /, '') || 'Operation failed. Try again.';
const movementLabel = (movementType) => ({ purchase_confirm: 'Stock received', order_confirm: 'Stock reserved / deducted', order_cancel: 'Stock released / restored', stock_adjustment: 'Stock adjustment' }[movementType] || String(movementType || 'Stock movement').replace(/_/g, ' '));

export function initOperationsUi({ db, functions }) {
  let user = null, profile = null, purchases = [], stocks = [], movements = [], items = [], units = [], types = [];
  let loadedPage = '';
  let dialogAction = null, draftId = null, adjustmentId = null, stockAtOpen = null;
  const confirmingPurchases = new Set();
  let sessionVersion = 0;
  const loadTokens = new Map();
  const loadRuns = new Map();
  const stopLoad = (page) => { const token = loadTokens.get(page); if (token) globalThis.omsLoading?.stop(token); loadTokens.delete(page); };

  async function refresh(page) {
    if (!profile) return;
    const version = sessionVersion, run = (loadRuns.get(page) || 0) + 1;
    loadRuns.set(page, run);
    const staff = isStaff(profile);
    const message = byId(page === 'purchases' ? 'purchase-message' : 'inventory-message');
    message.textContent = '';
    stopLoad(page);
    loadTokens.set(page, globalThis.omsLoading?.start(page === 'purchases' ? 'Loading purchases…' : 'Loading inventory…') || null);
    try {
      if (page === 'purchases') {
        if (!staff) return;
        const data = await Promise.all([listPurchases(db), listMasterRecords(db, 'purchaseTypes')]);
        if (version !== sessionVersion || run !== loadRuns.get(page)) return;
        [purchases, types] = data;
        renderPurchases();
      } else if (page === 'inventory') {
        if (staff) {
          const data = await Promise.all([listInventory(db), listMovements(db), listMasterRecords(db, 'items'), listMasterRecords(db, 'units')]);
          if (version !== sessionVersion || run !== loadRuns.get(page)) return;
          [stocks, movements, items, units] = data;
        } else {
          const ownMovements = await listMovements(db, user.uid);
          if (version !== sessionVersion || run !== loadRuns.get(page)) return;
          stocks = []; items = []; units = []; movements = ownMovements;
        }
        renderInventory();
      }
      loadedPage = page;
      message.textContent = '';
    } catch (error) {
      if (version === sessionVersion && run === loadRuns.get(page)) { console.error('Could not load operations:', error); message.textContent = `Could not load records: ${safeError(error)}`; }
    } finally { if (run === loadRuns.get(page)) stopLoad(page); }
  }

  const filteredPurchases = () => purchases.filter((purchase) => {
    const search = byId('purchase-search').value.toLowerCase();
    return (!search || `${purchase.supplierName} ${purchase.purchaseTypeSnapshot} ${purchase.notes || ''} ${purchase.paymentReference || ''} ${purchase.quantity ?? ''} ${purchase.unit || ''}`.toLowerCase().includes(search))
      && (!byId('purchase-status').value || purchase.status === byId('purchase-status').value)
      && (!byId('purchase-from').value || purchase.purchaseDate >= byId('purchase-from').value)
      && (!byId('purchase-to').value || purchase.purchaseDate <= byId('purchase-to').value);
  }).sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));

  function renderPurchases() {
    const data = filteredPurchases();
    byId('purchase-summary').textContent = `${data.length} purchases · ${data.filter((p) => p.status === 'draft').length} drafts · ${data.filter((p) => p.status === 'confirmed').length} confirmed · ₹${(data.filter((p) => p.status === 'confirmed').reduce((sum, p) => sum + (p.totalPaise || 0), 0) / 100).toLocaleString('en-IN')}`;
    byId('purchase-body').innerHTML = data.length ? data.map((p) => `<tr><td>${escaped(p.purchaseDate)}</td><td>${escaped(p.supplierName)}${/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,}\/view\/?$/.test(p.documentUrl || '') ? ` <a href="${escaped(p.documentUrl)}" target="_blank" rel="noopener noreferrer">Document</a>` : ''}</td><td>${escaped(p.purchaseTypeSnapshot)}</td><td>${p.quantity == null || p.quantity === '' ? 'Not recorded' : escaped(p.quantity)}</td><td>${p.unit ? escaped(p.unit) : 'Not recorded'}</td><td>${((p.totalPaise || 0) / 100).toLocaleString('en-IN')}</td><td>${escaped(p.paymentStatus || 'Not recorded')}</td><td>${escaped(p.status)}</td><td class="ops-actions">${p.status === 'draft' ? `<button type="button" data-op="edit" data-id="${escaped(p.id)}">Edit</button><button type="button" data-op="confirm" data-id="${escaped(p.id)}">Confirm</button>` : ''}${p.status !== 'cancelled' ? `<button type="button" data-op="cancel" data-id="${escaped(p.id)}">Cancel</button>` : ''}</td></tr>`).join('') : empty(9, 'No purchases match the filters.');
    byId('purchase-mobile-list').innerHTML = data.length ? data.map((p) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${escaped(p.supplierName)}</strong><span class="mobile-status">${escaped(p.status)}</span></div><p>${escaped(p.purchaseDate)} · ${escaped(p.purchaseTypeSnapshot)}<small>${p.quantity == null || p.quantity === '' ? 'Quantity not recorded' : `${escaped(p.quantity)} ${escaped(p.unit || '')}`}</small></p><div class="mobile-record-bottom"><b>₹${((p.totalPaise || 0) / 100).toLocaleString('en-IN')}</b><div class="mobile-record-actions">${p.status === 'draft' ? `<button type="button" data-op="edit" data-id="${escaped(p.id)}">Edit</button><button type="button" data-op="confirm" data-id="${escaped(p.id)}">Confirm</button>` : ''}${p.status !== 'cancelled' ? `<button type="button" data-op="cancel" data-id="${escaped(p.id)}">Cancel</button>` : ''}</div></div></article>`).join('') : '<p class="mobile-record-empty">No purchases match the current filters.</p>';
  }

  const selectedMovements = () => movements.filter((m) => {
    const search = byId('inventory-history-search').value.toLowerCase();
    const stamp = m.at?.toDate?.().toISOString().slice(0, 10) || '';
    return (!search || `${m.itemSnapshot?.name} ${m.itemSnapshot?.itemCode} ${m.movementType} ${m.reason} ${m.actorName || ''}`.toLowerCase().includes(search))
      && (!byId('inventory-item').value || m.itemId === byId('inventory-item').value)
      && (!byId('inventory-from').value || stamp >= byId('inventory-from').value)
      && (!byId('inventory-to').value || stamp <= byId('inventory-to').value);
  }).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));

  const stockFor = (item) => stocks.find((stock) => stock.id === item.id);
  const unitFor = (item) => units.find((unit) => unit.id === item.defaultUnitId)?.symbol || '';
  const availableFor = (item) => Math.max(0, (stockFor(item)?.onHandQty || 0) - (stockFor(item)?.reservedQty || 0));
  const statusFor = (item) => {
    const stock = stockFor(item), available = availableFor(item);
    if (item.active === false || stock?.sellingBlocked) return 'blocked';
    if (available === 0) return 'out_of_stock';
    if ((stock?.lowStockThresholdQty || 0) > 0 && available <= stock.lowStockThresholdQty) return 'low_stock';
    return 'available';
  };
  const statusLabel = { available: 'Available', low_stock: 'Low stock', out_of_stock: 'Out of stock', blocked: 'Blocked' };
  const filteredStockItems = () => items.filter((item) => {
    const search = byId('inventory-search').value.toLowerCase();
    const status = byId('inventory-status').value;
    return (!search || `${item.name} ${item.itemCode}`.toLowerCase().includes(search))
      && (!status || status === statusFor(item));
  });

  function renderInventory() {
    const staff = isStaff(profile);
    byId('inventory-cards').hidden = !staff;
    byId('inventory-status').hidden = !staff;
    const selectedItem = byId('inventory-item').value;
    byId('inventory-item').innerHTML = '<option value="">All items</option>' + (staff ? items.map((item) => `<option value="${escaped(item.id)}">${escaped(item.name)}</option>`).join('') : [...new Map(movements.map((m) => [m.itemId, m.itemSnapshot?.name])).entries()].map(([id, name]) => `<option value="${escaped(id)}">${escaped(name)}</option>`).join(''));
    byId('inventory-item').value = selectedItem;
    if (staff) {
      byId('inventory-cards').innerHTML = [['Total items', items.length], ['Low-stock items', items.filter((item) => statusFor(item) === 'low_stock').length], ['Out-of-stock items', items.filter((item) => statusFor(item) === 'out_of_stock').length], ['Blocked items', items.filter((item) => statusFor(item) === 'blocked').length]].map(([label, count]) => `<div class="card ops-stat"><span>${label}</span><strong>${count}</strong></div>`).join('');
      const filtered = filteredStockItems();
      byId('inventory-head').innerHTML = '<tr><th>Item / SKU</th><th>Available</th><th>Status</th><th>Low threshold</th><th>Actions</th></tr>';
      byId('inventory-body').innerHTML = filtered.length ? filtered.map((item) => {
        const stock = stockFor(item), unit = unitFor(item), status = statusFor(item);
        return `<tr><td>${escaped(item.name)} <small>${escaped(item.itemCode)}</small></td><td>${shownQty(availableFor(item))} ${escaped(unit)}</td><td><span class="inventory-status is-${status}">${statusLabel[status]}</span></td><td>${stock?.lowStockThresholdQty ? `${shownQty(stock.lowStockThresholdQty)} ${escaped(unit)}` : 'Not set'}</td><td class="ops-actions">${inventoryActions(item, stock)}</td></tr>`;
      }).join('') : empty(5, 'No items match the filters.');
      byId('inventory-mobile-list').innerHTML = filtered.length ? filtered.map((item) => { const stock = stockFor(item), unit = unitFor(item), status = statusFor(item); return `<article class="inventory-mobile-card"><div><strong>${escaped(item.name)}</strong><small>${escaped(item.itemCode)}</small></div><span class="inventory-status is-${status}">${statusLabel[status]}</span><p><b>${shownQty(availableFor(item))} ${escaped(unit)}</b> available</p><p>Low threshold: ${stock?.lowStockThresholdQty ? `${shownQty(stock.lowStockThresholdQty)} ${escaped(unit)}` : 'Not set'}</p><div class="ops-actions">${inventoryActions(item, stock)}</div></article>`; }).join('') : '<p class="inventory-empty">No items match the filters.</p>';
    } else { byId('inventory-head').innerHTML = ''; byId('inventory-body').innerHTML = ''; byId('inventory-mobile-list').innerHTML = ''; }
    const history = selectedMovements();
    byId('movement-summary').textContent = `${history.length} movements`;
    byId('movement-body').innerHTML = history.length ? history.map((m) => `<tr><td>${escaped(dateOf(m.at))}</td><td>${escaped(m.itemSnapshot?.name)} <small>${escaped(m.itemSnapshot?.itemCode)}</small></td><td>${shownQty(m.previousQty)} ${escaped(m.itemSnapshot?.unitSymbol)}</td><td>${m.changeQty > 0 ? '+' : ''}${shownQty(m.changeQty)} ${escaped(m.itemSnapshot?.unitSymbol)}</td><td>${shownQty(m.newQty)} ${escaped(m.itemSnapshot?.unitSymbol)}</td><td><strong>${escaped(movementLabel(m.movementType))}</strong><small>${escaped(m.reason)}</small></td><td>${escaped(m.actorName || 'Unknown user')}</td></tr>`).join('') : empty(7, staff ? 'No stock movements match the filters.' : 'No inventory activity is linked to your orders.');
  }
  function inventoryActions(item, stock) {
    const id = escaped(item.id);
    return `${hasPermission(profile, 'manageStock') ? `<button type="button" data-op="adjust" data-id="${id}">Adjust stock</button>${item.active === false ? '' : `<button type="button" data-op="${stock?.sellingBlocked ? 'unblock' : 'block'}" data-id="${id}">${stock?.sellingBlocked ? 'Unblock' : 'Block'}</button>`}<button type="button" data-op="threshold" data-id="${id}">Threshold</button>` : ''}<button type="button" data-op="history" data-id="${id}">History</button>`;
  }

  function field(label, name, type = 'text', value = '', extra = '') { return `<label class="ops-field">${label}<input name="${name}" type="${type}" value="${escaped(value)}" ${extra}></label>`; }
  function openDialog(action, id = null) {
    dialogAction = action; draftId = id; adjustmentId = action === 'adjust' ? uniqueId() : null;
    const purchase = purchases.find((p) => p.id === id);
    const item = items.find((i) => i.id === id);
    const stock = stocks.find((s) => s.id === id);
    stockAtOpen = stock ? { ...stock } : null;
    byId('ops-error').hidden = true;
    byId('ops-dialog-title').textContent = ({ draft: purchase ? 'Edit purchase draft' : 'New purchase draft', cancel: 'Cancel purchase', adjust: 'Physical stock count', block: 'Block item from selling', unblock: 'Unblock item for selling', threshold: 'Low-stock threshold' })[action];
    byId('ops-save').textContent = ({ adjust: 'Confirm stock count', block: 'Block item', unblock: 'Unblock item', threshold: 'Save threshold' })[action] || 'Save';
    if (action === 'draft') byId('ops-fields').innerHTML = `${field('Supplier name', 'supplierName', 'text', purchase?.supplierName, 'required maxlength="120"')}${field('Purchase date', 'purchaseDate', 'date', purchase?.purchaseDate || new Date().toISOString().slice(0, 10), 'required')}<label class="ops-field">Purchase type<select name="purchaseTypeId" required>${types.filter((t) => t.active).map((t) => `<option value="${escaped(t.id)}" ${purchase?.purchaseTypeId === t.id ? 'selected' : ''}>${escaped(t.name)}</option>`).join('')}</select></label><div class="purchase-measure-fields">${field('Quantity', 'quantity', 'text', purchase?.quantity ?? '', 'required maxlength="120"')}${field('Unit', 'unit', 'text', purchase?.unit ?? '', 'maxlength="80"')}</div>${field('Total amount (\u20b9)', 'total', 'number', purchase ? purchase.totalPaise / 100 : '', 'min="0" step="0.01" required')}${field('Paid amount (\u20b9)', 'paid', 'number', (purchase?.paidAmountPaise || 0) / 100, 'min="0" step="0.01" required')}<label class="ops-field">Payment mode<select name="paymentMode"><option value="cash" ${purchase?.paymentMode === 'cash' ? 'selected' : ''}>Cash</option><option value="upi" ${purchase?.paymentMode === 'upi' ? 'selected' : ''}>UPI</option><option value="bank_transfer" ${purchase?.paymentMode === 'bank_transfer' ? 'selected' : ''}>Bank transfer</option></select></label>${field('Payment reference (required for online payments)', 'paymentReference', 'text', purchase?.paymentReference || '', 'maxlength="100"')}<p class="muted">Payment status is calculated from the entered paid amount. Purchases do not change stock.</p>${field('Google Drive file view URL', 'documentUrl', 'url', purchase?.documentUrl || '')}<p class="muted">Drive access is controlled in Google Drive. Verify recipients before sharing.</p><label class="ops-field">Notes<textarea name="notes" maxlength="1000">${escaped(purchase?.notes || '')}</textarea></label>`;
    if (action === 'cancel') byId('ops-fields').innerHTML = `<p>Cancel ${escaped(purchase?.supplierName)}? Cancellation changes this purchase record only. Inventory and historical stock movements will not change.</p>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (action === 'adjust') byId('ops-fields').innerHTML = `<p><strong>${escaped(item?.name)}</strong><br>Current stock: ${shownQty(stock?.onHandQty)} ${escaped(unitFor(item))}</p>${field(`Counted physical quantity (${unitFor(item)})`, 'counted', 'number', stock?.onHandQty == null ? 0 : stock.onHandQty / 1000, 'min="0" step="0.001" required')}${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}<p class="muted">Enter the absolute physical count. The difference will be recorded as a stock movement.</p>`;
    if (action === 'block') byId('ops-fields').innerHTML = `<p>Block <strong>${escaped(item?.name)}</strong> from new order confirmations? Existing confirmed orders and stock history remain unchanged.</p>${field('Reason for blocking', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (action === 'unblock') byId('ops-fields').innerHTML = `<p>Unblock <strong>${escaped(item?.name)}</strong> for new order confirmations? Quantity will not change.</p>`;
    if (action === 'threshold') byId('ops-fields').innerHTML = `<p><strong>${escaped(item?.name)}</strong></p>${field(`Low-stock threshold (${unitFor(item)})`, 'threshold', 'number', (stock?.lowStockThresholdQty || 0) / 1000, 'min="0" step="0.001" required')}<p class="muted">A threshold of zero disables low-stock warnings.</p>`;
    byId('ops-dialog').showModal();
  }

  function toMilli(value) { if (String(value ?? '').trim() === '') throw new Error('Enter a quantity.'); const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) throw new Error('Use a nonnegative quantity with up to three decimal places.'); return Math.round(n * 1000); }
  function toPaise(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-7) throw new Error('Use a nonnegative cost with up to two decimal places.'); return Math.round(n * 100); }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form), button = byId('ops-save');
    if (button.disabled) return;
    button.disabled = true; byId('ops-error').hidden = true;
    try {
      if (!isStaff(profile)) throw new Error('Access denied: operational access is required.');
      if (['adjust', 'block', 'unblock', 'threshold'].includes(dialogAction) && !hasPermission(profile, 'manageStock')) throw new Error('Access denied: stock controls require a privileged OMS role.');
      let name, payload;
      if (dialogAction === 'draft') {
        const quantity = String(data.get('quantity') ?? '').trim();
        const unit = String(data.get('unit') ?? '').trim();
        if (!quantity || quantity.length > 120) throw new Error('Enter a quantity of 120 characters or fewer.');
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(quantity) && Number(quantity) <= 0) throw new Error('Quantity must be greater than zero.');
        if (unit.length > 80) throw new Error('Unit must be 80 characters or fewer.');
        payload = { quantity, unit, purchaseId: draftId || undefined, supplierName: data.get('supplierName'), purchaseDate: data.get('purchaseDate'), purchaseTypeId: data.get('purchaseTypeId'), notes: data.get('notes'), documentUrl: data.get('documentUrl'), totalPaise: toPaise(data.get('total')), paidAmountPaise: toPaise(data.get('paid')), paymentMode: data.get('paymentMode'), paymentReference: data.get('paymentReference') };
        name = 'savePurchaseDraft';
      } else if (dialogAction === 'cancel') { name = 'cancelPurchase'; payload = { purchaseId: draftId, reason: data.get('reason') }; }
      else if (dialogAction === 'adjust') { name = 'adjustStock'; payload = { itemId: draftId, countedQty: toMilli(data.get('counted')), expectedOnHandQty: stockAtOpen?.onHandQty || 0, reason: String(data.get('reason') || '').trim(), operationId: adjustmentId }; if (!payload.reason) throw new Error('Enter a reason for the stock count.'); }
      else if (['block', 'unblock', 'threshold'].includes(dialogAction)) {
        const stock = stockAtOpen;
        name = 'setInventoryControl';
        payload = { itemId: draftId, sellingBlocked: dialogAction === 'threshold' ? stock?.sellingBlocked === true : dialogAction === 'block', lowStockThresholdQty: dialogAction === 'threshold' ? toMilli(data.get('threshold')) : stock?.lowStockThresholdQty || 0, expectedSellingBlocked: stock?.sellingBlocked === true, expectedLowStockThresholdQty: stock?.lowStockThresholdQty || 0, reason: dialogAction === 'block' ? String(data.get('reason') || '').trim() : dialogAction === 'unblock' ? 'Selling unblocked' : 'Low-stock threshold updated' };
        if (!payload.reason) throw new Error('Enter a reason for blocking this item.');
      } else throw new Error('Unknown stock action.');
      await callOperation(functions, name, payload);
      byId('ops-dialog').close(); showToast('Operation saved.'); await refresh(name.includes('Purchase') ? 'purchases' : 'inventory');
    } catch (error) { byId('ops-error').textContent = safeError(error); byId('ops-error').hidden = false; }
    finally { button.disabled = false; }
  }

  async function exportXlsx(kind) {
    const purchaseRows = filteredPurchases();
    const history = selectedMovements();
    const summaries = kind === 'purchases' ? purchaseRows.map((p) => ({ Date: p.purchaseDate, Supplier: p.supplierName, Quantity: p.quantity ?? 'Not recorded', Unit: p.unit || 'Not recorded', Type: p.purchaseTypeSnapshot, Status: p.status, PaymentStatus: p.paymentStatus || 'Not recorded', PaidRupees: (p.paidAmountPaise || 0) / 100, PaymentMode: p.paymentMode || '', PaymentReference: p.paymentReference || '', Notes: p.notes || '', TotalRupees: (p.totalPaise || 0) / 100, DriveLink: p.documentUrl })) : history.map((m) => ({ When: dateOf(m.at), Item: m.itemSnapshot?.name, SKU: m.itemSnapshot?.itemCode, Unit: m.itemSnapshot?.unitSymbol, Previous: m.previousQty / 1000, Change: m.changeQty / 1000, Result: m.newQty / 1000, Reason: m.reason, Actor: m.actorName || 'Unknown user' }));
    const details = kind === 'purchases' ? [] : filteredStockItems().map((item) => ({ Item: item.name, SKU: item.itemCode, Unit: unitFor(item), Available: availableFor(item) / 1000, Status: statusLabel[statusFor(item)], LowThreshold: (stockFor(item)?.lowStockThresholdQty || 0) / 1000 }));
    if (!summaries.length && !details.length) return showToast('No records to export.', 'toast-error');
    try {
      await downloadXlsx(kind, kind === 'purchases' ? [['Purchases', summaries]] : [['Movements', summaries], ['Stock balances', details]]);
    } catch { showToast('XLSX library could not load. Check your connection.', 'toast-error'); }
  }

  document.addEventListener('oms:pagechange', (event) => { for (const page of loadTokens.keys()) if (page !== event.detail.page) stopLoad(page); if (['purchases', 'inventory'].includes(event.detail.page) && profile) refresh(event.detail.page); });
  byId('purchase-new').addEventListener('click', () => openDialog('draft'));
  byId('purchase-refresh').addEventListener('click', () => refresh('purchases'));
  byId('inventory-refresh').addEventListener('click', () => refresh('inventory'));
  byId('purchase-export').addEventListener('click', () => exportXlsx('purchases'));
  byId('inventory-export').addEventListener('click', () => exportXlsx('inventory'));
  ['purchase-search', 'purchase-status', 'purchase-from', 'purchase-to'].forEach((id) => byId(id).addEventListener('input', renderPurchases));
  ['inventory-search', 'inventory-item', 'inventory-status', 'inventory-history-search', 'inventory-from', 'inventory-to'].forEach((id) => byId(id).addEventListener('input', renderInventory));
  byId('purchase-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-op]'); if (!button || button.disabled || !isStaff(profile) || ['adjust', 'block', 'unblock', 'threshold'].includes(button.dataset.op) && !hasPermission(profile, 'manageStock')) return;
    const { op, id } = button.dataset;
    if (op === 'edit') return openDialog('draft', id);
    if (op === 'cancel') return openDialog('cancel', id);
    if (confirmingPurchases.has(id)) return;
    confirmingPurchases.add(id); button.disabled = true;
    try { await callOperation(functions, 'confirmPurchase', { purchaseId: id }); showToast('Purchase confirmed. Inventory unchanged.'); await refresh('purchases'); }
    catch (error) { showToast(safeError(error), 'toast-error'); }
    finally { confirmingPurchases.delete(id); button.disabled = false; }
  });
  byId('purchase-mobile-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-op]'); if (!button || button.disabled || !isStaff(profile)) return;
    const { op, id } = button.dataset;
    if (op === 'edit') return openDialog('draft', id);
    if (op === 'cancel') return openDialog('cancel', id);
    if (confirmingPurchases.has(id)) return;
    confirmingPurchases.add(id); button.disabled = true;
    try { await callOperation(functions, 'confirmPurchase', { purchaseId: id }); showToast('Purchase confirmed. Inventory unchanged.'); await refresh('purchases'); }
    catch (error) { showToast(safeError(error), 'toast-error'); }
    finally { confirmingPurchases.delete(id); button.disabled = false; }
  });
  function inventoryAction(event) {
    const button = event.target.closest('[data-op]'); if (!button || !isStaff(profile) || ['adjust', 'block', 'unblock', 'threshold'].includes(button.dataset.op) && !hasPermission(profile, 'manageStock')) return;
    if (button.dataset.op === 'history') { byId('inventory-item').value = button.dataset.id; renderInventory(); byId('movement-summary').scrollIntoView?.({ behavior: 'smooth', block: 'start' }); return; }
    openDialog(button.dataset.op, button.dataset.id);
  }
  byId('inventory-body').addEventListener('click', inventoryAction);
  byId('inventory-mobile-list').addEventListener('click', inventoryAction);
  byId('ops-form').addEventListener('submit', submit);
  byId('ops-dialog-close').addEventListener('click', () => byId('ops-dialog').close());
  byId('ops-cancel').addEventListener('click', () => byId('ops-dialog').close());

  return { setSession(nextUser, nextProfile) {
    sessionVersion++; for (const page of loadTokens.keys()) stopLoad(page); user = nextUser; profile = nextProfile; loadedPage = ''; purchases = []; stocks = []; movements = []; items = []; units = []; types = [];
    ['purchase-body', 'purchase-mobile-list', 'purchase-summary', 'inventory-body', 'inventory-mobile-list', 'inventory-cards', 'movement-body', 'movement-summary'].forEach((id) => { byId(id).innerHTML = ''; });
    if (profile && ['purchases', 'inventory'].includes(document.querySelector('[data-page].is-active')?.dataset.page)) refresh(document.querySelector('[data-page].is-active').dataset.page);
  } };
}
