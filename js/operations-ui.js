import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { listMasterRecords } from './master-data.js';
import { callOperation, listInventory, listMovements, listPurchases } from './operations-data.js';
import { downloadXlsx } from './xlsx-export.js';

const byId = (id) => document.getElementById(id);
const escaped = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shownQty = (value) => ((value || 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateOf = (value) => value?.toDate ? value.toDate().toLocaleString('en-IN') : '';
const empty = (columns, message) => `<tr><td colspan="${columns}" class="empty-cell">${escaped(message)}</td></tr>`;
const safeError = (error) => error?.message?.replace(/^.*?: /, '') || 'Operation failed. Try again.';

export function initOperationsUi({ db, functions }) {
  let user = null, profile = null, purchases = [], stocks = [], movements = [], items = [], types = [];
  let loadedPage = '';
  let dialogAction = null, draftId = null;
  let sessionVersion = 0;

  async function refresh(page) {
    if (!profile) return;
    const version = sessionVersion;
    const staff = isStaff(profile);
    const message = byId(page === 'purchases' ? 'purchase-message' : 'inventory-message');
    message.textContent = 'Loading records…';
    try {
      if (page === 'purchases') {
        if (!staff) return;
        const data = await Promise.all([listPurchases(db), listMasterRecords(db, 'purchaseTypes')]);
        if (version !== sessionVersion) return;
        [purchases, types] = data;
        renderPurchases();
      } else if (page === 'inventory') {
        if (staff) {
          const data = await Promise.all([listInventory(db), listMovements(db), listMasterRecords(db, 'items')]);
          if (version !== sessionVersion) return;
          [stocks, movements, items] = data;
        } else {
          const ownMovements = await listMovements(db, user.uid);
          if (version !== sessionVersion) return;
          stocks = []; items = []; movements = ownMovements;
        }
        renderInventory();
      }
      loadedPage = page;
      message.textContent = '';
    } catch (error) {
      if (version === sessionVersion) { console.error('Could not load operations:', error); message.textContent = `Could not load records: ${safeError(error)}`; }
    }
  }

  const filteredPurchases = () => purchases.filter((purchase) => {
    const search = byId('purchase-search').value.toLowerCase();
    return (!search || `${purchase.supplierName} ${purchase.purchaseTypeSnapshot} ${purchase.notes || ''} ${purchase.paymentReference || ''}`.toLowerCase().includes(search))
      && (!byId('purchase-status').value || purchase.status === byId('purchase-status').value)
      && (!byId('purchase-from').value || purchase.purchaseDate >= byId('purchase-from').value)
      && (!byId('purchase-to').value || purchase.purchaseDate <= byId('purchase-to').value);
  }).sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));

  function renderPurchases() {
    const data = filteredPurchases();
    byId('purchase-summary').textContent = `${data.length} purchases · ${data.filter((p) => p.status === 'draft').length} drafts · ${data.filter((p) => p.status === 'confirmed').length} confirmed · ₹${(data.filter((p) => p.status === 'confirmed').reduce((sum, p) => sum + (p.totalPaise || 0), 0) / 100).toLocaleString('en-IN')}`;
    byId('purchase-body').innerHTML = data.length ? data.map((p) => `<tr><td>${escaped(p.purchaseDate)}</td><td>${escaped(p.supplierName)}${/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,}\/view\/?$/.test(p.documentUrl || '') ? ` <a href="${escaped(p.documentUrl)}" target="_blank" rel="noopener noreferrer">Document</a>` : ''}</td><td>${escaped(p.purchaseTypeSnapshot)}</td><td>${((p.totalPaise || 0) / 100).toLocaleString('en-IN')}</td><td>${escaped(p.paymentStatus || 'Not recorded')}</td><td>${escaped(p.status)}</td><td class="ops-actions">${p.status === 'draft' ? `<button type="button" data-op="edit" data-id="${escaped(p.id)}">Edit</button><button type="button" data-op="confirm" data-id="${escaped(p.id)}">Confirm</button>` : ''}${p.status !== 'cancelled' ? `<button type="button" data-op="cancel" data-id="${escaped(p.id)}">Cancel</button>` : ''}</td></tr>`).join('') : empty(7, 'No purchases match the filters.');
  }

  const selectedMovements = () => movements.filter((m) => {
    const search = byId('inventory-search').value.toLowerCase();
    const stamp = m.at?.toDate?.().toISOString().slice(0, 10) || '';
    return (!search || `${m.itemSnapshot?.name} ${m.movementType} ${m.reason}`.toLowerCase().includes(search))
      && (!byId('inventory-item').value || m.itemId === byId('inventory-item').value)
      && (!byId('inventory-from').value || stamp >= byId('inventory-from').value)
      && (!byId('inventory-to').value || stamp <= byId('inventory-to').value);
  }).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));

  const filteredStockItems = () => items.filter((item) => {
    const stock = stocks.find((s) => s.id === item.id);
    const available = stock?.onHandQty || 0;
    const search = byId('inventory-search').value.toLowerCase();
    const status = byId('inventory-status').value;
    return (!search || `${item.name} ${item.itemCode}`.toLowerCase().includes(search))
      && (!byId('inventory-item').value || item.id === byId('inventory-item').value)
      && (!status || status === 'low' && available <= (stock?.lowStockThresholdQty || 0) || status === 'blocked' && stock?.sellingBlocked);
  });

  function renderInventory() {
    const staff = isStaff(profile);
    byId('inventory-cards').hidden = !staff;
    byId('inventory-status').hidden = !staff;
    const selectedItem = byId('inventory-item').value;
    byId('inventory-item').innerHTML = '<option value="">All items</option>' + (staff ? items.map((item) => `<option value="${escaped(item.id)}">${escaped(item.name)}</option>`).join('') : [...new Map(movements.map((m) => [m.itemId, m.itemSnapshot?.name])).entries()].map(([id, name]) => `<option value="${escaped(id)}">${escaped(name)}</option>`).join(''));
    byId('inventory-item').value = selectedItem;
    if (staff) {
      const low = stocks.filter((s) => s.onHandQty <= (s.lowStockThresholdQty || 0)).length;
      byId('inventory-cards').innerHTML = `<div class="card ops-stat"><span>Items with available stock</span><strong>${stocks.filter((s) => s.onHandQty > 0).length}</strong><small>See item-wise quantities below</small></div><div class="card ops-stat"><span>Low-stock items</span><strong>${low}</strong></div><div class="card ops-stat"><span>Blocked from selling</span><strong>${stocks.filter((s) => s.sellingBlocked).length}</strong></div>`;
      const filtered = filteredStockItems();
      byId('inventory-head').innerHTML = '<tr><th>Item</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Low threshold</th><th>Selling</th><th>Actions</th></tr>';
      byId('inventory-body').innerHTML = filtered.length ? filtered.map((item) => {
        const stock = stocks.find((s) => s.id === item.id);
        return `<tr><td>${escaped(item.name)} <small>${escaped(item.itemCode)}</small></td><td>${shownQty(stock?.onHandQty)}</td><td>0</td><td>${shownQty(stock?.onHandQty)}</td><td>${shownQty(stock?.lowStockThresholdQty)}</td><td>${stock?.sellingBlocked ? 'Blocked' : 'Open'}</td><td class="ops-actions"><button type="button" data-op="adjust" data-id="${escaped(item.id)}">Adjust</button><button type="button" data-op="control" data-id="${escaped(item.id)}">Controls</button></td></tr>`;
      }).join('') : empty(7, 'No items match the filters.');
    } else { byId('inventory-head').innerHTML = ''; byId('inventory-body').innerHTML = ''; }
    const history = selectedMovements();
    byId('movement-summary').textContent = `${history.length} movements · ${history.filter((m) => m.movementType === 'purchase_confirm').length} historical purchase receipts · ${history.filter((m) => m.movementType === 'physical_adjustment').length} adjustments`;
    byId('movement-body').innerHTML = history.length ? history.map((m) => `<tr><td>${escaped(dateOf(m.at))}</td><td>${escaped(m.itemSnapshot?.name)}</td><td>${escaped(m.movementType)}</td><td>${shownQty(m.changeQty)}</td><td>${shownQty(m.previousQty)}</td><td>${shownQty(m.newQty)}</td><td>${escaped(m.reason)}</td></tr>`).join('') : empty(7, staff ? 'No stock movements match the filters.' : 'No inventory activity is linked to your orders.');
  }

  function field(label, name, type = 'text', value = '', extra = '') { return `<label class="ops-field">${label}<input name="${name}" type="${type}" value="${escaped(value)}" ${extra}></label>`; }
  function openDialog(action, id = null) {
    dialogAction = action; draftId = id;
    const purchase = purchases.find((p) => p.id === id);
    const item = items.find((i) => i.id === id);
    const stock = stocks.find((s) => s.id === id);
    byId('ops-error').hidden = true;
    byId('ops-dialog-title').textContent = ({ draft: purchase ? 'Edit purchase draft' : 'New purchase draft', cancel: 'Cancel purchase', adjust: 'Physical stock count', control: 'Selling and low-stock controls' })[action];
    if (action === 'draft') byId('ops-fields').innerHTML = `${field('Supplier name', 'supplierName', 'text', purchase?.supplierName, 'required maxlength="120"')}${field('Purchase date', 'purchaseDate', 'date', purchase?.purchaseDate || new Date().toISOString().slice(0, 10), 'required')}<label class="ops-field">Purchase type<select name="purchaseTypeId" required>${types.filter((t) => t.active).map((t) => `<option value="${escaped(t.id)}" ${purchase?.purchaseTypeId === t.id ? 'selected' : ''}>${escaped(t.name)}</option>`).join('')}</select></label>${field('Total amount (\u20b9)', 'total', 'number', purchase ? purchase.totalPaise / 100 : '', 'min="0" step="0.01" required')}${field('Paid amount (\u20b9)', 'paid', 'number', (purchase?.paidAmountPaise || 0) / 100, 'min="0" step="0.01" required')}<label class="ops-field">Payment mode<select name="paymentMode"><option value="cash" ${purchase?.paymentMode === 'cash' ? 'selected' : ''}>Cash</option><option value="upi" ${purchase?.paymentMode === 'upi' ? 'selected' : ''}>UPI</option><option value="bank_transfer" ${purchase?.paymentMode === 'bank_transfer' ? 'selected' : ''}>Bank transfer</option></select></label>${field('Payment reference (required for online payments)', 'paymentReference', 'text', purchase?.paymentReference || '', 'maxlength="100"')}<p class="muted">Payment status is calculated from the entered paid amount. Purchases do not change stock.</p>${field('Google Drive file view URL', 'documentUrl', 'url', purchase?.documentUrl || '')}<p class="muted">Drive access is controlled in Google Drive. Verify recipients before sharing.</p><label class="ops-field">Notes<textarea name="notes" maxlength="1000">${escaped(purchase?.notes || '')}</textarea></label>`;
    if (action === 'cancel') byId('ops-fields').innerHTML = `<p>Cancel ${escaped(purchase?.supplierName)}? Cancellation changes this purchase record only. Inventory and historical stock movements will not change.</p>${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (action === 'adjust') byId('ops-fields').innerHTML = `<p>${escaped(item?.name)} · current on hand ${shownQty(stock?.onHandQty)}</p>${field('Counted physical quantity', 'counted', 'number', stock?.onHandQty ? stock.onHandQty / 1000 : 0, 'min="0" step="0.001" required')}${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    if (action === 'control') byId('ops-fields').innerHTML = `<p>${escaped(item?.name)}</p><label class="ops-field">Selling status<select name="sellingBlocked"><option value="false" ${!stock?.sellingBlocked ? 'selected' : ''}>Open</option><option value="true" ${stock?.sellingBlocked ? 'selected' : ''}>Blocked</option></select></label>${field('Low-stock threshold', 'threshold', 'number', (stock?.lowStockThresholdQty || 0) / 1000, 'min="0" step="0.001" required')}${field('Reason', 'reason', 'text', '', 'required maxlength="500"')}`;
    byId('ops-dialog').showModal();
  }

  function toMilli(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) throw new Error('Use a nonnegative quantity with up to three decimal places.'); return Math.round(n * 1000); }
  function toPaise(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-7) throw new Error('Use a nonnegative cost with up to two decimal places.'); return Math.round(n * 100); }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form), button = byId('ops-save');
    button.disabled = true; byId('ops-error').hidden = true;
    try {
      if (!isStaff(profile)) throw new Error('Staff access is required.');
      let name, payload;
      if (dialogAction === 'draft') {
        payload = { purchaseId: draftId || undefined, supplierName: data.get('supplierName'), purchaseDate: data.get('purchaseDate'), purchaseTypeId: data.get('purchaseTypeId'), notes: data.get('notes'), documentUrl: data.get('documentUrl'), totalPaise: toPaise(data.get('total')), paidAmountPaise: toPaise(data.get('paid')), paymentMode: data.get('paymentMode'), paymentReference: data.get('paymentReference') };
        name = 'savePurchaseDraft';
      } else if (dialogAction === 'cancel') { name = 'cancelPurchase'; payload = { purchaseId: draftId, reason: data.get('reason') }; }
      else if (dialogAction === 'adjust') { name = 'adjustStock'; payload = { itemId: draftId, countedQty: toMilli(data.get('counted')), reason: data.get('reason'), operationId: crypto.randomUUID() }; }
      else { name = 'setInventoryControl'; payload = { itemId: draftId, sellingBlocked: data.get('sellingBlocked') === 'true', lowStockThresholdQty: toMilli(data.get('threshold')), reason: data.get('reason') }; }
      await callOperation(functions, name, payload);
      byId('ops-dialog').close(); showToast('Operation saved.'); await refresh(name.includes('Purchase') ? 'purchases' : 'inventory');
    } catch (error) { byId('ops-error').textContent = safeError(error); byId('ops-error').hidden = false; }
    finally { button.disabled = false; }
  }

  async function exportXlsx(kind) {
    const purchaseRows = filteredPurchases();
    const history = selectedMovements();
    const summaries = kind === 'purchases' ? purchaseRows.map((p) => ({ Date: p.purchaseDate, Supplier: p.supplierName, Type: p.purchaseTypeSnapshot, Status: p.status, PaymentStatus: p.paymentStatus || 'Not recorded', PaidRupees: (p.paidAmountPaise || 0) / 100, PaymentMode: p.paymentMode || '', PaymentReference: p.paymentReference || '', Notes: p.notes || '', TotalRupees: (p.totalPaise || 0) / 100, DriveLink: p.documentUrl })) : history.map((m) => ({ Date: dateOf(m.at), Item: m.itemSnapshot?.name, Type: m.movementType, Change: m.changeQty / 1000, Previous: m.previousQty / 1000, New: m.newQty / 1000, Reason: m.reason }));
    const details = kind === 'purchases' ? [] : filteredStockItems().map((item) => { const stock = stocks.find((s) => s.id === item.id); return { ItemCode: item.itemCode, Item: item.name, OnHand: (stock?.onHandQty || 0) / 1000, Reserved: 0, Available: (stock?.onHandQty || 0) / 1000, LowThreshold: (stock?.lowStockThresholdQty || 0) / 1000, SellingBlocked: stock?.sellingBlocked === true }; });
    if (!summaries.length && !details.length) return showToast('No records to export.', 'toast-error');
    try {
      await downloadXlsx(kind, kind === 'purchases' ? [['Purchases', summaries]] : [['Movements', summaries], ['Stock balances', details]]);
    } catch { showToast('XLSX library could not load. Check your connection.', 'toast-error'); }
  }

  document.addEventListener('oms:pagechange', (event) => { if (['purchases', 'inventory'].includes(event.detail.page) && profile) refresh(event.detail.page); });
  byId('purchase-new').addEventListener('click', () => openDialog('draft'));
  byId('purchase-refresh').addEventListener('click', () => refresh('purchases'));
  byId('inventory-refresh').addEventListener('click', () => refresh('inventory'));
  byId('purchase-export').addEventListener('click', () => exportXlsx('purchases'));
  byId('inventory-export').addEventListener('click', () => exportXlsx('inventory'));
  ['purchase-search', 'purchase-status', 'purchase-from', 'purchase-to'].forEach((id) => byId(id).addEventListener('input', renderPurchases));
  ['inventory-search', 'inventory-item', 'inventory-status', 'inventory-from', 'inventory-to'].forEach((id) => byId(id).addEventListener('input', renderInventory));
  byId('purchase-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-op]'); if (!button || !isStaff(profile)) return;
    const { op, id } = button.dataset;
    if (op === 'edit') return openDialog('draft', id);
    if (op === 'cancel') return openDialog('cancel', id);
    button.disabled = true;
    try { await callOperation(functions, 'confirmPurchase', { purchaseId: id }); showToast('Purchase confirmed. Inventory unchanged.'); await refresh('purchases'); }
    catch (error) { showToast(safeError(error), 'toast-error'); }
    finally { button.disabled = false; }
  });
  byId('inventory-body').addEventListener('click', (event) => { const button = event.target.closest('[data-op]'); if (button && isStaff(profile)) openDialog(button.dataset.op, button.dataset.id); });
  byId('ops-form').addEventListener('submit', submit);
  byId('ops-dialog-close').addEventListener('click', () => byId('ops-dialog').close());
  byId('ops-cancel').addEventListener('click', () => byId('ops-dialog').close());

  return { setSession(nextUser, nextProfile) {
    sessionVersion++; user = nextUser; profile = nextProfile; loadedPage = ''; purchases = []; stocks = []; movements = []; items = []; types = [];
    ['purchase-body', 'purchase-summary', 'inventory-body', 'inventory-cards', 'movement-body', 'movement-summary'].forEach((id) => { byId(id).innerHTML = ''; });
    if (profile && ['purchases', 'inventory'].includes(document.querySelector('[data-page].is-active')?.dataset.page)) refresh(document.querySelector('[data-page].is-active').dataset.page);
  } };
}
