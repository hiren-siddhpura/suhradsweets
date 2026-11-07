import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { listCollections, listInvoices, listPayments } from './finance-data.js';
import { callOperation } from './operations-data.js';
import { isStaff, hasPermission } from './permissions.js';
import { uniqueId } from './unique-id.js';
import { showToast } from './ui.js';
import { eligibleCollectionInvoice } from './collection-eligibility.js';
import { bulkDraftHtml } from './bulk-draft-render.js';
import { listOrders } from './order-data.js';
import { assignedInvoiceUser, visibleBulkInvoices } from './bulk-invoice-filter.js';
import { downloadXlsx } from './xlsx-export.js';
import { sortUsersByName } from './user-sort.js';
import { cardIcon, cardButton } from './mobile-card.js';
import { paymentStatusStats } from './payment-status-stats.js';
import { pendingPaymentGroups } from './pending-payment.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '<': '&lt;', "'": '&#39;' })[char]);
const rupees = (paise) => `₹${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateTime = (stamp) => stamp?.toDate?.()?.toLocaleString('en-IN') || '';
const shortCollectionNumber = (value) => String(value || '').replace(/^(COL-\d{8}-[A-Z0-9]{8})[A-Z0-9]+$/i, '$1');
const collectionDay = () => { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; };
const validFile = (file) => {
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' })[file?.type];
  if (!extension || !new RegExp(`\\.${extension === 'jpg' ? 'jpe?g' : extension}$`, 'i').test(file.name)) throw new Error('Choose a JPG, JPEG, PNG or PDF receipt.');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Each receipt must be at most 5 MB.');
  return extension;
};
const readFile = (result) => {
  const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
};

export function initCollectionsUi({ db, functions }) {
  const parent = document.getElementById('payments-view');
  const root = document.createElement('section'); root.className = 'collections-section'; root.innerHTML = `
    <div class="payment-actions"><button id="payment-create" class="button button-primary" type="button"><span aria-hidden="true">＋</span> Create Payment</button><button id="collection-create" class="button button-primary" type="button"><span aria-hidden="true">▦</span> Create Bulk Payment</button></div>
    <div id="collection-cards" class="ops-cards"></div><div class="card ops-panel"><h3>Payment Records</h3><div class="ops-toolbar payment-filters"><input id="collection-search" type="search" placeholder="Payment / collection reference" aria-label="Search payment records"><label class="payment-filter-field">User<select id="collection-user"><option value="">All users</option></select></label><label class="payment-filter-field">Customer<input id="collection-customer" type="search" placeholder="Customer"></label><label class="payment-filter-field">Payment Mode<select id="collection-mode"><option value="">All modes</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Online</option></select></label><label class="payment-filter-field">Payment type<select id="collection-type"><option value="">All payment types</option><option value="single">Single Payment</option><option value="bulk">Bulk Payment</option></select></label><label class="payment-filter-field">Status<select id="collection-status"><option value="">All statuses</option><option value="pending">Pending verification</option><option value="verified">Approved</option><option value="rejected">Rejected</option><option value="reversed">Reversed</option></select></label><label class="payment-filter-field">From date<input id="collection-from" type="date"></label><label class="payment-filter-field">To date<input id="collection-to" type="date"></label><button id="collection-apply" class="button button-primary" type="button">Apply Filters</button><button id="collection-clear" class="button button-outline" type="button">Clear All</button><button id="collection-refresh" class="button button-outline" type="button">Refresh</button><button id="collection-export" class="button button-outline" type="button">Export XLSX</button></div><p id="collection-message" role="status"></p><div id="collection-list" class="collection-list"></div></div>
    <dialog id="collection-dialog" class="app-dialog collection-dialog" aria-label="Collection details"><div id="collection-dialog-content"></div></dialog>`;
  root.querySelector('#collection-cards').insertAdjacentHTML('afterend', '<section class="card delivery-users-section" aria-label="Pending Payment by User"><h3>Pending Payment by User</h3><div id="pending-payment-users" class="delivery-users"></div></section><section id="pending-payment-details" class="card delivery-users-section" hidden><h3 id="pending-payment-title">Pending payments</h3><div id="pending-payment-invoices" class="delivery-users"></div></section>');
  const heading = parent.querySelector(':scope > .section-heading');
  if (heading) heading.after(root); else parent.append(root);
  const $ = (id) => root.querySelector(`#${id}`);
  const filterValue = (id) => String($(id)?.value ?? '');
  let user = null, profile = null, collections = [], payments = [], invoices = [], orders = [], ownerNames = new Map(), paymentUsers = [], selectedPendingUser = '', draft = null, viewingId = null, loadingRevision = 0, busy = false, exportedRows = [], appliedFilters = {};
  const own = () => isStaff(profile) ? null : user?.uid;
  const invoiceAvailable = eligibleCollectionInvoice;
  function renderPendingPayments() {
    const groups = pendingPaymentGroups(invoices, paymentUsers, orders);
    $('pending-payment-users').innerHTML = groups.length ? `<table class="delivery-users-table pending-payment-table"><thead><tr><th scope="col">Assigned User</th><th scope="col">Pending Invoices</th><th scope="col">Pending Amount</th><th scope="col">Action</th></tr></thead><tbody>${groups.map((group) => `<tr><th scope="row">${esc(group.userName)}</th><td>${group.count}</td><td>${rupees(group.amountPaise)}</td><td><button type="button" class="ops-link" data-pending-payment-user="${esc(group.userId)}" aria-label="View pending payments for ${esc(group.userName)}">View Pending →</button></td></tr>`).join('')}</tbody></table>` : '<p class="payment-pending-empty">No pending payments 🎉</p>';
    const group = groups.find((item) => item.userId === selectedPendingUser);
    $('pending-payment-details').hidden = !group;
    if (!group) return;
    $('pending-payment-title').textContent = `Pending payments · ${group.userName}`;
    $('pending-payment-invoices').innerHTML = `<table class="delivery-users-table pending-payment-table"><thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Pending Amount</th><th scope="col">Action</th></tr></thead><tbody>${group.invoices.map((invoice) => `<tr><th scope="row">${esc(invoice.invoiceNumber || invoice.id)}</th><td>${esc(invoice.customerSnapshot?.fullName || '')}</td><td>${rupees(invoice.remainingPaise)}</td><td><button type="button" class="ops-link" data-pending-invoice="${esc(invoice.id)}">View invoice →</button></td></tr>`).join('')}</tbody></table>`;
  }
  function renderList() {
    renderPendingPayments();
    const singles = payments.filter((row) => !row.collectionId && !row.collectionNumber);
    const records = [
      ...singles.map((row) => ({ type: 'single', row, ownerUid: row.ownerUid, modes: [row.mode], status: row.reversalId ? 'reversed' : row.verificationStatus === 'unverified' ? 'pending' : row.verificationStatus, amount: row.amountPaise, method: paymentName(row.mode), day: row.submittedAt?.toDate?.()?.toISOString().slice(0, 10) || '', at: row.submittedAt?.seconds || 0, reference: row.transactionNumber || row.invoiceNumber || row.id, collector: row.submittedByName || '', customer: row.customerSnapshot?.fullName || '' })),
      ...collections.map((row) => ({ type: 'bulk', row, ownerUid: row.ownerUid, modes: row.entries?.map((entry) => entry.mode) || [], status: row.status, amount: row.totalPaise, method: new Set(row.entries?.map((entry) => entry.mode)).size > 1 ? 'Mixed' : paymentName(row.entries?.[0]?.mode) || '—', day: row.collectionDate || '', at: row.submittedAt?.seconds || 0, reference: shortCollectionNumber(row.collectionNumber || row.id), collector: row.submittedByName || '', customer: row.allocations?.map((item) => item.customerName).join(' ') || '' })),
    ];
    const { search = '', user: selectedUser = '', customer = '', mode = '', type = '', status = '', from = '', to = '' } = appliedFilters;
    const pendingInvoiceIds = new Set(pendingPaymentGroups(invoices, paymentUsers, orders).find((group) => group.userId === selectedPendingUser)?.invoices.map((invoice) => invoice.id) || []);
    const rows = records.filter((item) => {
      const assignedPending = selectedPendingUser && selectedUser === selectedPendingUser;
      const matchesUser = !selectedUser || (assignedPending
        ? item.type === 'single' ? pendingInvoiceIds.has(item.row.invoiceId) : item.row.allocations?.some((allocation) => pendingInvoiceIds.has(allocation.invoiceId))
        : item.ownerUid === selectedUser);
      return (!type || item.type === type) && matchesUser && (!mode || item.modes.includes(mode)) && (!status || item.status === status) && (!from || item.day >= from) && (!to || item.day <= to) && (!search || `${item.reference} ${item.row.invoiceNumber || ''} ${item.row.collectionNumber || ''}`.toLowerCase().includes(search.toLowerCase())) && (!customer || item.customer.toLowerCase().includes(customer.toLowerCase()));
    }).sort((a, b) => b.at - a.at);
    const stats = paymentStatusStats(rows, invoices, appliedFilters);
    const statCard = (label, value, share, base) => `<div class="card ops-stat payment-summary-stat"><span>${label}</span><strong>${rupees(value)}</strong><small>${share.toLocaleString('en-IN', { maximumFractionDigits: 1 })}% of ${base}</small><div class="payment-summary-track" role="progressbar" aria-label="${label} percentage of ${base}" aria-valuenow="${share.toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, share)}%"></span></div></div>`;
    $('collection-cards').innerHTML = statCard('Total Payments', stats.totalPayments, stats.totalPaymentsPercent, 'total payment amount') + statCard('Pending Payments', stats.pendingPayments, stats.pendingPaymentsPercent, 'total payment amount') + statCard('Approved Payments', stats.approvedPayments, stats.approvedPaymentsPercent, 'total payment amount') + statCard('Pending Collection', stats.pendingCollection, stats.pendingCollectionPercent, 'total collection amount') + statCard('Cash Collection', stats.cashCollection, stats.cashCollectionPercent, 'total collection amount') + statCard('Online Collection', stats.onlineCollection, stats.onlineCollectionPercent, 'total collection amount');
    exportedRows = rows;
    const actions = (item) => `<button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-view="${esc(item.row.id)}">View</button>${hasPermission(profile, 'verifyPayments') && item.status === 'pending' ? `<button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-approve="${esc(item.row.id)}">Approve</button><button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-reject="${esc(item.row.id)}">Reject</button>` : ''}`;
    $('collection-list').innerHTML = rows.length ? `<div class="table-scroll mobile-table"><table><thead><tr><th>Reference</th><th>Type</th><th>Customer / Customers</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>${rows.map((item) => `<tr><td><strong>${esc(item.reference)}</strong></td><td>${item.type === 'bulk' ? 'Bulk Payment' : 'Single Payment'}</td><td>${esc(item.type === 'bulk' ? `${item.row.customerCount || 0} customers` : item.customer)}<small>${esc(item.collector)}</small></td><td class="payment-amount">${rupees(item.amount)}</td><td>${esc(item.method)}</td><td><span class="payment-record-status is-${esc(item.status)}">${esc(statusName(item.status))}</span></td><td>${esc(item.day)}</td><td class="ops-actions">${actions(item)}</td></tr>`).join('')}</tbody></table></div><div class="mobile-record-list">${rows.map((item) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(item.reference)}</strong><span class="mobile-status">${esc(statusName(item.status))}</span></div><p>${item.type === 'bulk' ? 'Bulk Payment' : 'Single Payment'} · ${esc(item.customer)}<small>${esc(item.day)} · ${esc(item.collector)} · ${esc(item.method)}</small></p><div class="mobile-record-bottom"><b>${rupees(item.amount)}</b><div class="mobile-record-actions">${actions(item)}</div></div></article>`).join('')}</div>` : `<div class="payment-empty-state"><div class="payment-empty-icon" aria-hidden="true">₹</div><h4>No payment records found</h4><p>${records.length ? 'Try adjusting the current filters.' : 'Create a payment or bulk payment to see records here.'}</p>${records.length ? '' : '<div><button type="button" data-empty-create class="button button-primary">＋ Create Payment</button><button type="button" data-empty-bulk class="button button-outline">▦ Create Bulk Payment</button></div>'}</div>`;
    const mobileList = $('collection-list').querySelector?.('.mobile-record-list');
    if (mobileList) mobileList.innerHTML = rows.map((item) => {
      const bulk = item.type === 'bulk';
      const viewAttribute = bulk ? 'data-collection-view' : 'data-single-view';
      const view = `<button type="button" class="order-card-action" ${viewAttribute}="${esc(item.row.id)}" aria-label="View ${bulk ? 'collection' : 'payment'} ${esc(item.reference)}" title="View details">${cardIcon('view')}<span>View</span></button>`;
      const review = hasPermission(profile, 'verifyPayments') && item.status === 'pending' ? `${cardButton('approve', item.row.id, 'Approve payment', 'check', bulk ? 'data-collection-action' : 'data-single-action')}${cardButton('reject', item.row.id, 'Reject payment', 'reject', bulk ? 'data-collection-action' : 'data-single-action')}` : '';
      return `<article class="order-mobile-card"><div class="order-card-header"><strong>${esc(item.reference)}</strong><span class="mobile-status is-${esc(item.status)}">${esc(statusName(item.status))}</span></div><h3 class="order-card-customer">${esc(item.customer || (bulk ? `${item.row.customerCount || 0} customers` : 'Customer unavailable'))}</h3><div class="order-card-meta"><span>${cardIcon('calendar')}${esc(item.day)}</span><span>${cardIcon('payment')}${esc(item.method)}</span>${bulk ? `<span>${cardIcon('invoice')}Bulk collection · ${item.row.allocations?.length || 0} invoices</span>` : `<span>${cardIcon('invoice')}${esc(item.row.invoiceNumber)}</span>`}</div><div class="order-card-total"><span>${bulk ? 'Collection Amount' : 'Payment Amount'}</span><strong>${rupees(item.amount)}</strong></div><div class="order-card-actions">${view}${!bulk && item.row.attachment ? `<button type="button" class="order-card-action" data-single-receipt="${esc(item.row.id)}" aria-label="View receipt" title="View receipt">${cardIcon('receipt')}<span>Receipt</span></button>` : ''}${review}</div></article>`;
    }).join('');

  }
  async function load() {
    if (!user || !profile) return;
    const revision = ++loadingRevision, token = globalThis.omsLoading?.start('Loading collections…');
    try {
      const owner = own();
      const [collectionRows, paymentRows, invoiceRows, orderRows] = await Promise.all([listCollections(db, owner), listPayments(db, owner), listInvoices(db, owner), listOrders(db, owner)]);
      if (revision !== loadingRevision) return;
      collections = collectionRows; payments = paymentRows; invoices = invoiceRows; orders = orderRows;
      let userRows = [{ id: user.uid, displayName: profile.displayName || profile.fullName || profile.name || 'My payments' }];
      if (isStaff(profile)) {
        try { userRows = (await getDocs(collection(db, 'users'))).docs.map((doc) => ({ id: doc.id, ...doc.data() })); }
        catch { userRows = [...new Set(orders.map((row) => row.assignedUserId || row.ownerUid).filter(Boolean))].map((id) => ({ id, displayName: ownerNames.get(id) || id })); }
      }
      paymentUsers = userRows;
      const selectedUser = $('collection-user').value;
      $('collection-user').innerHTML = `<option value="">All users</option>${sortUsersByName(userRows.filter((row) => row.active !== false)).map((row) => `<option value="${esc(row.id)}">${esc(row.displayName || row.fullName || row.name || row.email || row.id)}</option>`).join('')}`;
      $('collection-user').value = selectedUser;
      $('collection-message').textContent = ''; renderList();
    } catch (error) { if (revision === loadingRevision) $('collection-message').textContent = `Could not load collections: ${error.message}`; }
    finally { globalThis.omsLoading?.stop(token); }
  }
  const reference = () => `COL-${collectionDay().replaceAll('-', '')}-${draft.operationId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const paymentName = (mode) => ({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Online' })[mode] || mode;
  const statusName = (status) => ({ pending: 'Pending verification', verified: 'Approved', rejected: 'Rejected', reversed: 'Reversed' })[status] || status;
  function draftTotals() {
    const allocations = [...draft.allocations.entries()].map(([invoiceId, row]) => ({ invoiceId, ...row }));
    return { allocations, total: allocations.reduce((sum, row) => sum + (row.amountPaise || 0), 0) };
  }
  function syncEntryAmounts() {
    draft.entries.forEach((entry, index) => {
      if (entry.manualAmount) return;
      const amount = [...draft.allocations.values()].filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + (Number(row.amountPaise) || 0), 0);
      entry.amountPaise = amount; entry.amountRaw = (amount / 100).toFixed(2);
      const control = root.querySelector(`[data-entry-amount="${index}"]`);
      if (control && document.activeElement !== control) control.value = entry.amountRaw;
    });
  }
  function visibleDraftInvoices() {
    return visibleBulkInvoices(invoices, draft.filters, invoiceAvailable);
  }
  function renderDraft() {
    if (!draft) return;
    $('collection-dialog-content').innerHTML = bulkDraftHtml({ draft, invoices, names: ownerNames, eligible: invoiceAvailable, reference: reference(), collectionDate: collectionDay(), collectedBy: profile?.fullName || profile?.displayName || user?.uid || '—' });
    $('collection-close').onclick = $('collection-cancel').onclick = () => $('collection-dialog').close();
    $('collection-refresh-invoices').onclick = refreshDraftInvoices;
    $('collection-clear-filters').onclick = () => { draft.filters = { owner: '', number: '', customer: '', status: '' }; renderDraft(); };
    $('collection-select-visible').onclick = () => { for (const invoice of visibleDraftInvoices()) if (!draft.allocations.has(invoice.id)) draft.allocations.set(invoice.id, { amountPaise: invoice.totalPaise - invoice.verifiedPaidPaise, paymentIndex: 0 }); changed(); syncEntryAmounts(); renderDraft(); };
    $('collection-deselect-all').onclick = () => { draft.allocations.clear(); changed(); syncEntryAmounts(); renderDraft(); };
    $('collection-add-entry').onclick = () => { if (draft.entries.length >= 20) return; draft.entries.push({ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null, amountPaise: 0, amountRaw: '0.00', manualAmount: false }); changed(); renderDraft(); };
    $('collection-remarks').oninput = (event) => { draft.remarks = event.target.value; changed(); };
    $('collection-submit').onclick = submit;
    root.querySelectorAll('[data-bulk-filter]').forEach((node) => { node.oninput = (event) => { draft.filters[node.dataset.bulkFilter] = event.target.value; if (node.dataset.bulkFilter === 'owner' && event.target.value) { for (const id of draft.allocations.keys()) if (invoices.find((invoice) => invoice.id === id)?.assignedUserId !== event.target.value) draft.allocations.delete(id); syncEntryAmounts(); } const position = node.selectionStart; renderDraft(); const next = root.querySelector(`[data-bulk-filter="${node.dataset.bulkFilter}"]`); next?.focus(); if (position !== null && next?.setSelectionRange) next.setSelectionRange(position, position); }; });
  }
  function changed() {
    if (draft.entries.some((entry) => entry.uploaded)) { draft.operationId = uniqueId(); draft.entries.forEach((entry) => { entry.uploaded = null; }); }
  }
  function updateDraftSummary() {
    if (!draft) return;
    const { allocations, total } = draftTotals();
    const totals = $('collection-summary-totals');
    const outstanding = allocations.reduce((sum, row) => { const invoice = invoices.find((item) => item.id === row.invoiceId); return sum + (invoice ? invoice.totalPaise - invoice.verifiedPaidPaise : 0); }, 0);
    const entryTotal = draft.entries.reduce((sum, entry) => sum + (Number(entry.amountPaise) || 0), 0);
    if (totals) totals.textContent = `${allocations.length} invoices · ${rupees(outstanding)} outstanding · ${rupees(total)} allocated · ${draft.entries.length} entries · Difference ${rupees(total - entryTotal)}`;
    const button = $('collection-submit');
    if (button) button.disabled = draft.invoiceLoading || draft.invoiceError || !allocations.length || !Number.isSafeInteger(total) || total <= 0 || total !== entryTotal || allocations.some((row) => { const invoice = invoices.find((item) => item.id === row.invoiceId); return !invoice || !Number.isSafeInteger(row.amountPaise) || row.amountPaise <= 0 || row.amountPaise > invoice.totalPaise - invoice.verifiedPaidPaise; }) || draft.entries.some((entry, index) => !Number.isSafeInteger(entry.amountPaise) || entry.amountPaise <= 0 || (entry.mode !== 'cash' && (!entry.transactionNumber.trim() || !entry.file)) || allocations.filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + row.amountPaise, 0) !== entry.amountPaise);
  }
  function openCreate() {
    draft?.entries.forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
    draft = { operationId: uniqueId(), allocations: new Map(), filters: { owner: '', number: '', customer: '', status: '' }, entries: [{ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null, amountPaise: 0, amountRaw: '0.00', manualAmount: false }], remarks: '', invoiceLoading: false, invoiceError: false };
    renderDraft(); $('collection-dialog').showModal(); refreshDraftInvoices();
  }
  async function refreshDraftInvoices() {
    const currentDraft = draft;
    if (!currentDraft || currentDraft.invoiceLoading) return;
    currentDraft.invoiceLoading = true; currentDraft.invoiceError = false; renderDraft();
    try {
      const [fresh, orderRows] = await Promise.all([listInvoices(db, own()), listOrders(db, isStaff(profile) ? null : user.uid)]);
      if (draft !== currentDraft) return;
      const ordersById = new Map(orderRows.map((order) => [order.id, order]));
      invoices = fresh.map((invoice) => ({ ...invoice, assignedUserId: assignedInvoiceUser(invoice, ordersById) }));
      ownerNames = new Map([[user.uid, profile?.fullName || profile?.displayName || user.uid]]);
      if (isStaff(profile)) {
        try { const snap = await getDocs(collection(db, 'users')); if (draft !== currentDraft) return; for (const row of snap.docs) ownerNames.set(row.id, row.data().fullName || row.data().displayName || row.id); }
        catch (error) { console.warn('Bulk payment user names unavailable', { code: error.code || 'unknown' }); }
      }
      for (const [id] of currentDraft.allocations) if (!invoices.some((invoice) => invoice.id === id && invoiceAvailable(invoice) && (!currentDraft.filters.owner || invoice.assignedUserId === currentDraft.filters.owner))) currentDraft.allocations.delete(id);
      syncEntryAmounts();
      console.info('Bulk payment invoice availability', { invoiceCount: fresh.length, eligibleCount: fresh.filter(invoiceAvailable).length });
    } catch (error) {
      if (draft !== currentDraft) return;
      currentDraft.invoiceError = true;
      console.warn('Bulk payment invoice load failed', { code: error.code || 'unknown' });
    } finally {
      if (draft === currentDraft) { currentDraft.invoiceLoading = false; renderDraft(); }
    }
  }
  async function submit() {
    if (busy || !draft) return;
    const { allocations, total } = draftTotals();
    try {
      if (draft.invoiceLoading || draft.invoiceError) throw new Error('Refresh invoice balances before submitting.');
      if (!allocations.length || !total || allocations.some((row) => !Number.isSafeInteger(row.amountPaise) || row.amountPaise < 1)) throw new Error('Select invoices and enter a positive collected amount for each.');
      for (const row of allocations) {
        const invoice = invoices.find((item) => item.id === row.invoiceId);
        if (row.amountPaise > invoice.totalPaise - invoice.verifiedPaidPaise) throw new Error(`Amount exceeds the balance for ${invoice.invoiceNumber}.`);
      }
      const entryTotals = draft.entries.map((_, index) => allocations.filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + row.amountPaise, 0));
      if (entryTotals.some((amount, index) => !amount || amount !== draft.entries[index].amountPaise)) throw new Error('Payment entry amounts must match their invoice allocations.');
      for (const entry of draft.entries) {
        if (entry.mode !== 'cash' && (!entry.transactionNumber.trim() || !entry.file)) throw new Error('UPI and Online entries need a transaction ID and receipt.');
        if (entry.file) validFile(entry.file);
      }
      busy = true; $('collection-submit').disabled = true; $('collection-error').textContent = '';
      const entries = [];
      for (let index = 0; index < draft.entries.length; index++) {
        const entry = draft.entries[index];
        if (entry.file && !entry.uploaded) {
          const extension = validFile(entry.file), path = `collectionReceipts/${user.uid}/${draft.operationId}/${index}.${extension}`;
          const token = globalThis.omsLoading?.start(`Uploading receipt ${index + 1}…`);
          try {
            const task = uploadBytesResumable(storageRef(getStorage(db.app), path), entry.file, { contentType: entry.file.type, customMetadata: { ownerUid: user.uid, operationId: draft.operationId, originalName: entry.file.name.slice(0, 150) } });
            await new Promise((resolve, reject) => task.on('state_changed', (snapshot) => { const node = $(`collection-progress-${index}`); if (node) node.textContent = `Uploading ${Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100)}%`; }, reject, resolve));
            entry.uploaded = { extension };
          } finally { globalThis.omsLoading?.stop(token); }
        }
        entries.push({ mode: entry.mode, amountPaise: entry.amountPaise, transactionNumber: entry.mode === 'cash' ? '-' : entry.transactionNumber, attachment: entry.uploaded });
      }
      const result = await callOperation(functions, 'submitCollection', { operationId: draft.operationId, allocations: allocations.map(({ invoiceId, amountPaise, paymentIndex }) => ({ invoiceId, amountPaise, paymentIndex })), entries, remarks: draft.remarks });
      $('collection-dialog').close(); showToast(`${shortCollectionNumber(result.collectionNumber)} submitted for verification.`); draft = null; await load();
    } catch (error) { $('collection-error').textContent = error.message || 'Collection could not be submitted. Retry.'; }
    finally { busy = false; if ($('collection-submit')) $('collection-submit').disabled = false; }
  }
  async function view(id) {
    const row = collections.find((item) => item.id === id); if (!row) return;
    viewingId = id;
    const grouped = new Map(); for (const item of row.allocations) { if (!grouped.has(item.customerId)) grouped.set(item.customerId, []); grouped.get(item.customerId).push(item); }
    const content = $('collection-dialog-content');
    content.innerHTML = `<div class="dialog-header"><h2>${esc(shortCollectionNumber(row.collectionNumber))}</h2><button id="collection-detail-close" class="icon-button" type="button" aria-label="Close">×</button></div><p>${esc(row.collectionDate)} · ${esc(statusName(row.status))} · Collected by ${esc(row.submittedByName)} · Submitted ${esc(dateTime(row.submittedAt))}</p><p>Verified by ${esc(row.verifiedByName || '—')} · ${esc(dateTime(row.verifiedAt))}</p>${row.rejectionReason ? `<p>Rejection reason: ${esc(row.rejectionReason)}</p>` : ''}
      ${[...grouped.values()].map((items) => `<div class="collection-customer"><h3>${esc(items[0].customerName)} · ${rupees(items.reduce((sum, item) => sum + item.amountPaise, 0))}</h3>${items.map((item) => { const current = invoices.find((invoice) => invoice.id === item.invoiceId); return `<p>${esc(item.invoiceNumber)} · ${rupees(item.amountPaise)} collected · ${rupees(current ? current.totalPaise - current.verifiedPaidPaise : item.balanceAtSubmissionPaise - (row.status === 'verified' ? item.amountPaise : 0))} remaining</p>`; }).join('')}</div>`).join('')}
      <h3>Payment entries</h3>${row.entries.map((entry, index) => `<p>${index + 1}. ${esc(paymentName(entry.mode))} · ${rupees(entry.amountPaise)} · ${esc(entry.transactionNumber)} ${entry.attachment ? `<button type="button" data-collection-receipt="${index}">Preview / download receipt</button>` : ''}</p>`).join('')}<p><strong>Submitted ${rupees(row.totalPaise)} · Approved ${rupees(row.approvedPaise)}</strong></p><p>Remarks: ${esc(row.remarks || '—')}</p><h3>Activity</h3><div id="collection-history">Loading history…</div><div class="dialog-actions">${hasPermission(profile, 'verifyPayments') && row.status === 'pending' ? `<button type="button" data-collection-approve="${esc(row.id)}" class="button button-primary">Approve</button><button type="button" data-collection-reject="${esc(row.id)}" class="button button-outline">Reject</button>` : ''}<button id="collection-detail-done" type="button" class="button button-outline">Close</button></div>`;
    $('collection-detail-close').onclick = $('collection-detail-done').onclick = () => $('collection-dialog').close();
    $('collection-dialog').showModal();
    try {
      const filters = [where('referenceId', '==', id)]; if (!isStaff(profile)) filters.push(where('ownerUid', '==', user.uid), where('referenceType', '==', 'collection'));
      const snap = await getDocs(query(collection(db, 'auditLogs'), ...filters));
      const events = snap.docs.map((item) => item.data()).sort((a, b) => (a.at?.seconds || 0) - (b.at?.seconds || 0));
      const node = $('collection-history'); if (node) node.innerHTML = events.map((item) => `<p>${esc(dateTime(item.at))} · ${esc(item.type)} · ${esc(item.actorName)} ${item.detail?.reason ? `· ${esc(item.detail.reason)}` : ''}</p>`).join('') || '<p>No activity yet.</p>';
    } catch { const node = $('collection-history'); if (node) node.textContent = 'History could not be loaded.'; }
  }
  async function review(id, decision) {
    if (!hasPermission(profile, 'verifyPayments') || busy) return;
    if (decision === 'verified' && globalThis.confirm && !globalThis.confirm('Approve this collection and apply its payments to invoice balances?')) return;
    let reason = '';
    if (decision === 'rejected') {
      if (!$('collection-dialog').open || viewingId !== id) await view(id);
      let input = root.querySelector('#collection-rejection-reason');
      if (!input) {
        $('collection-dialog-content').querySelector('.dialog-actions').insertAdjacentHTML('beforebegin', '<label class="ops-field">Rejection reason<textarea id="collection-rejection-reason" maxlength="500" required></textarea></label><button id="collection-confirm-rejection" type="button" class="button button-primary">Confirm rejection</button>');
        input = root.querySelector('#collection-rejection-reason');
        $('collection-confirm-rejection').onclick = () => review(id, 'rejected'); input.focus(); return;
      }
      reason = input.value.trim(); if (!reason) return showToast('A rejection reason is required.', 'toast-error');
      if (globalThis.confirm && !globalThis.confirm('Reject this collection? Its payments will not count toward invoice balances.')) return;
    }
    busy = true;
    const reviewToken = globalThis.omsLoading?.start(decision === 'verified' ? 'Approving collection…' : 'Rejecting collection…');
    try { await callOperation(functions, 'reviewCollection', { collectionId: id, decision, reason }); $('collection-dialog').close(); showToast(decision === 'verified' ? 'Collection approved.' : 'Collection rejected.'); await load(); }
    catch (error) { showToast(error.message, 'toast-error'); } finally { globalThis.omsLoading?.stop(reviewToken); busy = false; }
  }
  async function showReceipt(id, index) {
    try {
      const result = await callOperation(functions, 'readCollectionReceipt', { collectionId: id, entryIndex: index }), url = readFile(result);
      const dialog = document.createElement('dialog'); dialog.className = 'app-dialog receipt-dialog';
      const title = document.createElement('h2'); title.textContent = 'Collection receipt'; dialog.append(title);
      const preview = document.createElement(result.contentType === 'application/pdf' ? 'iframe' : 'img'); preview.src = url; preview.title = 'Receipt preview'; preview.alt = 'Receipt preview'; dialog.append(preview);
      const link = document.createElement('a'); link.className = 'button button-primary'; link.href = url; link.download = result.name || 'receipt'; link.textContent = 'Download'; dialog.append(link);
      const collection = collections.find((row) => row.id === id);
      const status = document.createElement('p'); status.textContent = `Status: ${statusName(collection?.status)} · Reviewed by ${collection?.verifiedByName || '—'} · ${dateTime(collection?.verifiedAt)}${collection?.rejectionReason ? ` · Reason: ${collection.rejectionReason}` : ''}`; dialog.append(status);
      if (hasPermission(profile, 'verifyPayments') && collection?.status === 'pending') for (const [decision, label] of [['verified', 'Approve'], ['rejected', 'Reject']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = decision === 'verified' ? 'button button-approve' : 'button button-reject'; button.textContent = label;
        button.onclick = () => { dialog.close(); void review(id, decision); }; dialog.append(button);
      }
      const close = document.createElement('button'); close.className = 'button button-outline'; close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(close);
      dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); }; document.body.append(dialog); dialog.showModal();
    } catch (error) { showToast(error.message, 'toast-error'); }
  }
  root.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-collection-action],[data-single-action]');
    if (quick) {
      if (quick.dataset.collectionAction) return review(quick.dataset.id, quick.dataset.collectionAction === 'approve' ? 'verified' : 'rejected');
      document.dispatchEvent(new CustomEvent('oms:single-payment-action', { detail: { kind: quick.dataset.singleAction === 'approve' ? 'verify' : 'reject', id: quick.dataset.id } })); return;
    }
    if (event.target.closest('[data-empty-create]')) { $('payment-create').click(); return; }
    if (event.target.closest('[data-empty-bulk]')) { $('collection-create').click(); return; }
    const single = event.target.closest('[data-single-view],[data-single-approve],[data-single-reject]');
    if (single) {
      const id = single.dataset.singleView || single.dataset.singleApprove || single.dataset.singleReject;
      if (single.dataset.singleView) {
        const row = payments.find((item) => item.id === id); if (!row) return;
        $('collection-dialog-content').innerHTML = `<div class="dialog-header"><h2>Single Payment</h2><button id="single-close" class="icon-button" type="button" aria-label="Close">×</button></div><p>Reference: ${esc(row.transactionNumber || '—')}</p><p>Customer: ${esc(row.customerSnapshot?.fullName)} · Order: ${esc(row.orderNumber)} · Invoice: ${esc(row.invoiceNumber)}</p><p>Amount: ${rupees(row.amountPaise)} · Method: ${esc(paymentName(row.mode))}</p><p>Submitted by: ${esc(row.submittedByName || row.submittedBy)} · ${esc(dateTime(row.submittedAt))}</p><p>Status: ${esc(statusName(row.reversalId ? 'reversed' : row.verificationStatus === 'unverified' ? 'pending' : row.verificationStatus))}</p><p>Verified by: ${esc(row.verifiedByName || row.verifiedBy || '—')} · ${esc(dateTime(row.verifiedAt))}${row.receivedBy ? ` · Received by ${esc(row.receivedByName || row.receivedBy)}` : ''}</p>${row.remarks ? `<p>Remarks: ${esc(row.remarks)}</p>` : ''}${row.reviewReason ? `<p>Reason: ${esc(row.reviewReason)}</p>` : ''}<div class="dialog-actions">${row.attachment ? `<button type="button" data-single-receipt="${esc(id)}" class="button button-outline">Receipt</button>` : ''}<button id="single-done" type="button" class="button button-outline">Close</button></div>`;
        if (hasPermission(profile, 'verifyPayments') && row.verificationStatus === 'unverified') $('collection-dialog-content').querySelector('.dialog-actions').insertAdjacentHTML('afterbegin', `<button type="button" data-single-approve="${esc(id)}" class="button button-approve">Approve</button><button type="button" data-single-reject="${esc(id)}" class="button button-reject">Reject</button>`);
        $('single-close').onclick = $('single-done').onclick = () => $('collection-dialog').close(); $('collection-dialog').showModal(); return;
      }
      if ($('collection-dialog').open) $('collection-dialog').close();
      document.dispatchEvent(new CustomEvent('oms:single-payment-action', { detail: { kind: single.dataset.singleApprove ? 'verify' : 'reject', id } })); return;
    }
    const receipt = event.target.closest('[data-single-receipt]'); if (receipt) { document.dispatchEvent(new CustomEvent('oms:single-payment-action', { detail: { kind: 'receipt', id: receipt.dataset.singleReceipt } })); return; }
    const target = event.target.closest('[data-collection-view],[data-collection-approve],[data-collection-reject],[data-collection-receipt],[data-remove-invoice],[data-invoice-check],[data-entry-remove-file],[data-entry-remove]'); if (!target) return;
    if (target.dataset.collectionView) return view(target.dataset.collectionView);
    if (target.dataset.collectionApprove) return review(target.dataset.collectionApprove, 'verified');
    if (target.dataset.collectionReject) return review(target.dataset.collectionReject, 'rejected');
    if (target.dataset.collectionReceipt !== undefined) return showReceipt(viewingId, Number(target.dataset.collectionReceipt));
    if (!draft) return;
    if (target.dataset.removeInvoice) { draft.allocations.delete(target.dataset.removeInvoice); changed(); syncEntryAmounts(); renderDraft(); }
    if (target.dataset.invoiceCheck) { const id = target.dataset.invoiceCheck, invoice = invoices.find((item) => item.id === id); if (target.checked && invoice && invoiceAvailable(invoice)) draft.allocations.set(id, { amountPaise: invoice.totalPaise - invoice.verifiedPaidPaise, paymentIndex: 0 }); else draft.allocations.delete(id); changed(); syncEntryAmounts(); renderDraft(); }
    if (target.dataset.entryRemoveFile !== undefined) { const entry = draft.entries[Number(target.dataset.entryRemoveFile)]; if (entry.url) URL.revokeObjectURL(entry.url); entry.file = null; entry.url = null; entry.uploaded = null; changed(); renderDraft(); }
    if (target.dataset.entryRemove !== undefined) { const index = Number(target.dataset.entryRemove); if (draft.allocations.size && [...draft.allocations.values()].some((item) => item.paymentIndex === index)) return showToast('Move invoice allocations to another payment entry first.', 'toast-error'); const [entry] = draft.entries.splice(index, 1); if (entry.url) URL.revokeObjectURL(entry.url); for (const row of draft.allocations.values()) if (row.paymentIndex > index) row.paymentIndex--; changed(); renderDraft(); }
  });
  root.addEventListener('change', (event) => {
    if (!draft) return; const target = event.target;
    if (target.dataset.invoiceEntry) { draft.allocations.get(target.dataset.invoiceEntry).paymentIndex = Number(target.value); changed(); syncEntryAmounts(); renderDraft(); }
    if (target.dataset.invoiceAmount) { syncEntryAmounts(); renderDraft(); }
    if (target.dataset.entryMode !== undefined) { draft.entries[Number(target.dataset.entryMode)].mode = target.value; changed(); renderDraft(); }
    if (target.dataset.entryFile !== undefined) {
      const entry = draft.entries[Number(target.dataset.entryFile)], file = target.files?.[0]; if (!file) return;
      if (target.files.length !== 1) { showToast('Choose one receipt per payment entry.', 'toast-error'); target.value = ''; return; }
      try { validFile(file); if (entry.url) URL.revokeObjectURL(entry.url); entry.file = file; entry.url = URL.createObjectURL(file); changed(); renderDraft(); }
      catch (error) { showToast(error.message, 'toast-error'); target.value = ''; }
    }
  });
  root.addEventListener('input', (event) => {
    if (!draft) return; const target = event.target;
    if (target.dataset.invoiceAmount) { const row = draft.allocations.get(target.dataset.invoiceAmount); if (row) { row.amountRaw = target.value; row.amountPaise = /^\d+(?:\.\d{1,2})?$/.test(target.value) ? Math.round(Number(target.value) * 100) : NaN; } changed(); syncEntryAmounts(); updateDraftSummary(); }
    if (target.dataset.entryAmount !== undefined) { const entry = draft.entries[Number(target.dataset.entryAmount)]; entry.amountRaw = target.value; entry.amountPaise = /^\d+(?:\.\d{1,2})?$/.test(target.value) ? Math.round(Number(target.value) * 100) : NaN; entry.manualAmount = true; changed(); updateDraftSummary(); }
    if (target.dataset.entryReference !== undefined) { draft.entries[Number(target.dataset.entryReference)].transactionNumber = target.value; changed(); updateDraftSummary(); }
  });
  $('payment-create').onclick = () => document.dispatchEvent(new CustomEvent('oms:create-single-payment'));
  $('collection-create').onclick = openCreate; $('collection-refresh').onclick = load;
  const collectionFilterIds = ['search', 'user', 'customer', 'mode', 'type', 'status', 'from', 'to'];
  const applyCollectionFilters = () => { appliedFilters = Object.fromEntries(collectionFilterIds.map((field) => [field, filterValue(`collection-${field}`).trim()])); if (appliedFilters.user !== selectedPendingUser || appliedFilters.status !== 'pending') selectedPendingUser = ''; renderList(); };
  $('collection-apply').onclick = applyCollectionFilters;
  $('pending-payment-users').addEventListener('click', (event) => {
    const id = event.target.closest('[data-pending-payment-user]')?.dataset.pendingPaymentUser;
    if (!id) return;
    selectedPendingUser = id;
    $('collection-user').value = id;
    $('collection-status').value = 'pending';
    appliedFilters = { user: id, status: 'pending' };
    renderList();
    $('pending-payment-details').scrollIntoView?.({ block: 'nearest' });
  });
  $('pending-payment-invoices').addEventListener('click', (event) => {
    const id = event.target.closest('[data-pending-invoice]')?.dataset.pendingInvoice;
    if (!id) return;
    for (const field of ['search', 'status', 'user', 'customer', 'from', 'to']) {
      const control = document.getElementById(`invoice-${field}`);
      if (control?.value) { control.value = ''; control.dispatchEvent(new Event('input')); }
    }
    [...document.querySelectorAll('#invoice-body [data-finance="preview"]')].find((button) => button.dataset.id === id)?.click();
  });
  $('collection-clear').onclick = () => { collectionFilterIds.forEach((field) => { $(`collection-${field}`).value = ''; }); appliedFilters = {}; selectedPendingUser = ''; renderList(); };
  $('collection-search').addEventListener('input', () => { appliedFilters.search = filterValue('collection-search').trim(); renderList(); });
  $('collection-export').onclick = async () => {
    try { await downloadXlsx('payment-records', [['Payment Records', exportedRows.map((item) => ({ Reference: item.reference, Type: item.type, Customer: item.customer, User: ownerNames.get(item.ownerUid) || item.ownerUid || '', Amount: item.amount / 100, Mode: item.method, Status: statusName(item.status), Date: item.day }))]]); }
    catch { showToast('XLSX export could not load.', 'toast-error'); }
  };
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'payments') load(); });
  document.addEventListener('oms:payment-changed', load);
  return { setSession(nextUser, nextProfile) { loadingRevision++; user = nextUser; profile = nextProfile; collections = []; payments = []; invoices = []; orders = []; paymentUsers = []; selectedPendingUser = ''; appliedFilters = {}; ownerNames = new Map(); if (user && profile) load(); else { $('collection-list').innerHTML = ''; $('pending-payment-users').innerHTML = ''; $('pending-payment-details').hidden = true; $('collection-dialog').close(); } } };
}
