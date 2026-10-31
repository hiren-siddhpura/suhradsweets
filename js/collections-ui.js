import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { listCollections, listInvoices, listPayments } from './finance-data.js';
import { callOperation } from './operations-data.js';
import { isStaff, hasPermission } from './permissions.js';
import { uniqueId } from './unique-id.js';
import { showToast } from './ui.js';
import { paymentInvoiceSummary, paymentUpload } from './payment-form-ui.js';
import { eligibleCollectionInvoice } from './collection-eligibility.js';

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
    <div id="collection-cards" class="ops-cards"></div><div class="card ops-panel"><h3>Payment Records</h3><div class="ops-toolbar"><input id="collection-search" type="search" placeholder="Payment / collection reference" aria-label="Payment or collection reference"><input id="collection-karyakarta" type="search" placeholder="Karyakarta" aria-label="Filter Karyakarta"><input id="collection-customer" type="search" placeholder="Customer" aria-label="Filter customer"><select id="collection-type" aria-label="Payment type"><option value="">All payment types</option><option value="single">Single Payment</option><option value="bulk">Bulk Payment</option></select><select id="collection-status" aria-label="Payment status"><option value="">All statuses</option><option value="pending">Pending verification</option><option value="verified">Approved</option><option value="rejected">Rejected</option><option value="reversed">Reversed</option></select><input id="collection-from" type="date" aria-label="Payments from"><input id="collection-to" type="date" aria-label="Payments to"><button id="collection-refresh" class="button button-outline" type="button">Refresh</button></div><p id="collection-message" role="status"></p><div id="collection-list" class="collection-list"></div></div>
    <dialog id="collection-dialog" class="app-dialog collection-dialog" aria-label="Collection details"><div id="collection-dialog-content"></div></dialog>`;
  const heading = parent.querySelector(':scope > .section-heading');
  if (heading) heading.after(root); else parent.append(root);
  const $ = (id) => root.querySelector(`#${id}`);
  const filterValue = (id) => String($(id)?.value ?? '');
  let user = null, profile = null, collections = [], payments = [], customers = [], invoices = [], draft = null, viewingId = null, loadingRevision = 0, busy = false;
  const own = () => isStaff(profile) ? null : user?.uid;
  const invoiceAvailable = eligibleCollectionInvoice;
  function renderList() {
    const singles = payments.filter((row) => !row.collectionId && !row.collectionNumber);
    const records = [
      ...singles.map((row) => ({ type: 'single', row, status: row.reversalId ? 'reversed' : row.verificationStatus === 'unverified' ? 'pending' : row.verificationStatus, amount: row.amountPaise, method: paymentName(row.mode), day: row.submittedAt?.toDate?.()?.toISOString().slice(0, 10) || '', at: row.submittedAt?.seconds || 0, reference: row.transactionNumber || row.invoiceNumber || row.id, collector: row.submittedByName || '', customer: row.customerSnapshot?.fullName || '' })),
      ...collections.map((row) => ({ type: 'bulk', row, status: row.status, amount: row.totalPaise, method: new Set(row.entries?.map((entry) => entry.mode)).size > 1 ? 'Mixed' : paymentName(row.entries?.[0]?.mode) || '—', day: row.collectionDate || '', at: row.submittedAt?.seconds || 0, reference: shortCollectionNumber(row.collectionNumber || row.id), collector: row.submittedByName || '', customer: row.allocations?.map((item) => item.customerName).join(' ') || '' })),
    ];
    $('collection-cards').innerHTML = `<div class="card ops-stat"><span>Pending Verification</span><strong>${records.filter((item) => item.status === 'pending').length}</strong></div><div class="card ops-stat"><span>Approved Payments</span><strong>${records.filter((item) => item.status === 'verified').length}</strong></div><div class="card ops-stat"><span>Approved Total</span><strong>${rupees(records.filter((item) => item.status === 'verified').reduce((sum, item) => sum + (item.type === 'bulk' ? item.row.approvedPaise ?? item.amount : item.amount), 0))}</strong></div>`;
    const search = filterValue('collection-search').trim().toLowerCase(), collector = filterValue('collection-karyakarta').trim().toLowerCase(), customer = filterValue('collection-customer').trim().toLowerCase(), type = filterValue('collection-type'), status = filterValue('collection-status'), from = filterValue('collection-from'), to = filterValue('collection-to');
    const rows = records.filter((item) => (!type || item.type === type) && (!status || item.status === status) && (!from || item.day >= from) && (!to || item.day <= to) && (!search || `${item.reference} ${item.row.invoiceNumber || ''} ${item.row.collectionNumber || ''}`.toLowerCase().includes(search)) && (!collector || item.collector.toLowerCase().includes(collector)) && (!customer || item.customer.toLowerCase().includes(customer))).sort((a, b) => b.at - a.at);
    const actions = (item) => `<button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-view="${esc(item.row.id)}">View</button>${hasPermission(profile, 'verifyPayments') && item.status === 'pending' ? `<button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-approve="${esc(item.row.id)}">Approve</button><button type="button" data-${item.type === 'bulk' ? 'collection' : 'single'}-reject="${esc(item.row.id)}">Reject</button>` : ''}`;
    $('collection-list').innerHTML = rows.length ? `<div class="table-scroll mobile-table"><table><thead><tr><th>Reference</th><th>Type</th><th>Customer / Customers</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>${rows.map((item) => `<tr><td><strong>${esc(item.reference)}</strong></td><td>${item.type === 'bulk' ? 'Bulk Payment' : 'Single Payment'}</td><td>${esc(item.type === 'bulk' ? `${item.row.customerCount || 0} customers` : item.customer)}<small>${esc(item.collector)}</small></td><td class="payment-amount">${rupees(item.amount)}</td><td>${esc(item.method)}</td><td><span class="payment-record-status is-${esc(item.status)}">${esc(statusName(item.status))}</span></td><td>${esc(item.day)}</td><td class="ops-actions">${actions(item)}</td></tr>`).join('')}</tbody></table></div><div class="mobile-record-list">${rows.map((item) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(item.reference)}</strong><span class="mobile-status">${esc(statusName(item.status))}</span></div><p>${item.type === 'bulk' ? 'Bulk Payment' : 'Single Payment'} · ${esc(item.customer)}<small>${esc(item.day)} · ${esc(item.collector)} · ${esc(item.method)}</small></p><div class="mobile-record-bottom"><b>${rupees(item.amount)}</b><div class="mobile-record-actions">${actions(item)}</div></div></article>`).join('')}</div>` : `<div class="payment-empty-state"><div class="payment-empty-icon" aria-hidden="true">₹</div><h4>No payment records found</h4><p>${records.length ? 'Try adjusting the current filters.' : 'Create a payment or bulk payment to see records here.'}</p>${records.length ? '' : '<div><button type="button" data-empty-create class="button button-primary">＋ Create Payment</button><button type="button" data-empty-bulk class="button button-outline">▦ Create Bulk Payment</button></div>'}</div>`;

  }
  async function load() {
    if (!user || !profile) return;
    const revision = ++loadingRevision, token = globalThis.omsLoading?.start('Loading collections…');
    try {
      const owner = own();
      const customerQuery = owner ? [query(collection(db, 'customers'), where('assignedUserId', '==', owner)), query(collection(db, 'customers'), where('ownerUserIds', 'array-contains', owner))] : [collection(db, 'customers')];
      const [collectionRows, paymentRows, invoiceRows, ...customerSnaps] = await Promise.all([listCollections(db, owner), listPayments(db, owner), listInvoices(db, owner), ...customerQuery.map((item) => getDocs(item))]);
      if (revision !== loadingRevision) return;
      collections = collectionRows; payments = paymentRows; invoices = invoiceRows;
      customers = [...new Map(customerSnaps.flatMap((snap) => snap.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]))).values()];
      $('collection-message').textContent = ''; renderList();
    } catch (error) { if (revision === loadingRevision) $('collection-message').textContent = `Could not load collections: ${error.message}`; }
    finally { globalThis.omsLoading?.stop(token); }
  }
  const reference = () => `COL-${collectionDay().replaceAll('-', '')}-${draft.operationId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const paymentName = (mode) => ({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Online' })[mode] || mode;
  const statusName = (status) => ({ pending: 'Pending verification', verified: 'Approved', rejected: 'Rejected', reversed: 'Reversed' })[status] || status;
  function draftTotals() {
    const allocations = [...draft.allocations.entries()].map(([invoiceId, row]) => ({ invoiceId, ...row }));
    return { allocations, total: allocations.reduce((sum, row) => sum + (row.amountPaise || 0), 0), customers: new Set(allocations.map((row) => invoices.find((invoice) => invoice.id === row.invoiceId)?.customerId)).size };
  }
  function renderDraft() {
    if (!draft) return;
    const selected = new Set(draft.customers), invoiceCounts = new Map();
    for (const invoice of invoices) if (invoiceAvailable(invoice)) invoiceCounts.set(invoice.customerId, (invoiceCounts.get(invoice.customerId) || 0) + 1);
    const available = customers.filter((customer) => !selected.has(customer.id)).sort((a, b) => (invoiceCounts.get(b.id) || 0) - (invoiceCounts.get(a.id) || 0) || String(a.fullName || '').localeCompare(String(b.fullName || '')));
    const customerOption = (customer) => `<option value="${esc(customer.id)}">${esc(customer.fullName)} · ${invoiceCounts.get(customer.id) || 0} outstanding invoice${invoiceCounts.get(customer.id) === 1 ? '' : 's'}</option>`;
    const { allocations, total, customers: customerCount } = draftTotals();
    $('collection-dialog-content').innerHTML = `<div class="dialog-header"><h2>Create Bulk Payment</h2><button id="collection-close" class="icon-button" type="button" aria-label="Close">×</button></div>
      <div class="payment-draft-meta"><span><strong>Draft reference</strong>${esc(reference())}</span><span><strong>Collection date</strong>${esc(collectionDay())}</span><span><strong>Collected by</strong>${esc(profile?.fullName || profile?.displayName || user?.uid || '—')}</span></div>
      <section class="payment-form-section"><div class="payment-section-heading"><h3>Customer Payments</h3><span>${customerCount} selected</span></div><div class="collection-add"><label class="ops-field" for="collection-customer-search">Find customer<input id="collection-customer-search" type="search" placeholder="Search customer name or phone"></label><label class="ops-field" for="collection-customer-pick">Customer<select id="collection-customer-pick"><option value="">Select customer</option>${available.map(customerOption).join('')}</select></label><button id="collection-add-customer" class="button button-outline" type="button">＋ Add Customer</button></div>
      ${draft.invoiceLoading ? '<p class="muted" role="status">Loading current invoice balances…</p>' : draft.invoiceError ? `<p class="form-error" role="alert">Could not load invoices. <button type="button" id="collection-retry-invoices">Retry</button></p>` : ''}
      ${draft.customers.map((customerId) => {
        const customer = customers.find((item) => item.id === customerId), rows = draft.invoiceLoading || draft.invoiceError ? [] : invoices.filter((invoice) => invoice.customerId === customerId && invoiceAvailable(invoice));
        const sum = rows.reduce((value, invoice) => value + (draft.allocations.get(invoice.id)?.amountPaise || 0), 0);
        return `<div class="collection-customer"><div class="payment-card-header"><h4>${esc(customer?.fullName || 'Customer')}</h4><button type="button" data-remove-customer="${esc(customerId)}" class="button button-outline" aria-label="Remove ${esc(customer?.fullName || 'customer')}">Remove</button></div><p class="payment-card-subtotal">Customer subtotal <strong data-customer-subtotal="${esc(customerId)}">${rupees(sum)}</strong></p>${rows.length ? rows.map((invoice) => {
          const row = draft.allocations.get(invoice.id), balance = invoice.totalPaise - invoice.verifiedPaidPaise;
          return `<div class="collection-invoice"><label class="payment-invoice-choice"><input type="checkbox" data-invoice-check="${esc(invoice.id)}" ${row ? 'checked' : ''}><span>${esc(invoice.invoiceNumber)}</span></label>${paymentInvoiceSummary(invoice)}${row ? `<div class="collection-allocation"><label class="ops-field">Amount collected (₹)<input type="number" min="0.01" step="0.01" max="${(balance / 100).toFixed(2)}" data-invoice-amount="${esc(invoice.id)}" value="${esc(row.amountRaw ?? (row.amountPaise / 100).toFixed(2))}"></label><label class="ops-field">Payment entry<select data-invoice-entry="${esc(invoice.id)}">${draft.entries.map((entry, index) => `<option value="${index}" ${row.paymentIndex === index ? 'selected' : ''}>${index + 1}: ${paymentName(entry.mode)}</option>`).join('')}</select></label></div>` : ''}</div>`;
        }).join('') : draft.invoiceLoading || draft.invoiceError ? '' : '<p class="muted">No eligible outstanding invoices are available for this customer.</p>'}</div>`;
      }).join('')}</section>
      <section class="payment-form-section"><div class="payment-section-heading"><h3>Payment Entries</h3><span>${draft.entries.length} entries</span></div>${draft.entries.map((entry, index) => `<div class="collection-entry"><div class="payment-card-header"><h4>Entry ${index + 1}</h4>${draft.entries.length > 1 ? `<button type="button" data-entry-remove="${index}" class="button button-outline">Remove entry</button>` : ''}</div><p class="payment-card-subtotal">Allocated to this entry <strong data-entry-total="${index}">${rupees(allocations.filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + row.amountPaise, 0))}</strong></p><div class="payment-form-grid"><label class="ops-field">Payment method<select data-entry-mode="${index}"><option value="cash" ${entry.mode === 'cash' ? 'selected' : ''}>Cash</option><option value="upi" ${entry.mode === 'upi' ? 'selected' : ''}>UPI</option><option value="bank_transfer" ${entry.mode === 'bank_transfer' ? 'selected' : ''}>Online</option></select></label><label class="ops-field" ${entry.mode === 'cash' ? 'hidden' : ''}>Transaction ID<input data-entry-reference="${index}" maxlength="100" value="${esc(entry.transactionNumber || '')}" ${entry.mode === 'cash' ? 'disabled' : ''}></label></div>${paymentUpload({ id: `collection-entry-file-${index}`, dataAttribute: `data-entry-file="${index}"` })}${entry.file ? `<p class="payment-file-name">${esc(entry.file.name)} · ${(entry.file.size / 1024 / 1024).toFixed(2)} MB <button type="button" data-entry-remove-file="${index}">Remove</button></p><div class="collection-file-preview">${entry.file.type === 'application/pdf' ? `<iframe title="Receipt preview" src="${entry.url}"></iframe>` : `<img alt="Receipt preview" src="${entry.url}">`}</div>` : ''}<p id="collection-progress-${index}" role="status"></p></div>`).join('')}<button id="collection-add-entry" class="button button-outline" type="button">＋ Add Payment Entry</button></section>
      <section class="payment-form-section"><label class="ops-field">Remarks <small>Optional</small><textarea id="collection-remarks" maxlength="1000" rows="3">${esc(draft.remarks)}</textarea></label><div class="collection-summary"><strong>Collection Summary</strong><p id="collection-summary-totals">${customerCount} customers · ${allocations.length} invoices · ${draft.entries.length} payment entries · Total ${rupees(total)}</p><small>Each invoice allocation is assigned to one payment entry. The entry totals must cover the full collection amount.</small></div></section><p id="collection-error" class="form-error" role="alert"></p><div class="dialog-actions"><button id="collection-cancel" type="button" class="button button-outline">Cancel</button><button id="collection-submit" type="button" class="button button-primary">Submit for Verification</button></div>`;
    $('collection-close').onclick = $('collection-cancel').onclick = () => $('collection-dialog').close();
    if ($('collection-retry-invoices')) $('collection-retry-invoices').onclick = refreshDraftInvoices;
    $('collection-customer-search').oninput = (event) => { const term = event.target.value.trim().toLowerCase(); const select = $('collection-customer-pick'); select.innerHTML = `<option value="">Select customer</option>${available.filter((customer) => `${customer.fullName || ''} ${customer.contact || ''}`.toLowerCase().includes(term)).map(customerOption).join('')}`; };
    $('collection-add-customer').onclick = () => { const id = $('collection-customer-pick').value; if (id) { draft.customers.push(id); changed(); renderDraft(); refreshDraftInvoices(); } };
    $('collection-add-entry').onclick = () => { if (draft.entries.length >= 20) return; draft.entries.push({ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null }); changed(); renderDraft(); };
    $('collection-remarks').oninput = (event) => { draft.remarks = event.target.value; changed(); };
    $('collection-submit').onclick = submit;
  }
  function changed() {
    if (draft.entries.some((entry) => entry.uploaded)) { draft.operationId = uniqueId(); draft.entries.forEach((entry) => { entry.uploaded = null; }); }
  }
  function updateDraftSummary() {
    if (!draft) return;
    const { allocations, total, customers: customerCount } = draftTotals();
    const totals = $('collection-summary-totals');
    if (totals) totals.textContent = `${customerCount} customers · ${allocations.length} invoices · ${draft.entries.length} payment entries · Total ${rupees(total)}`;
    for (const customerId of draft.customers) {
      const subtotal = root.querySelector(`[data-customer-subtotal="${CSS.escape(customerId)}"]`);
      if (subtotal) subtotal.textContent = rupees(allocations.filter((row) => invoices.find((invoice) => invoice.id === row.invoiceId)?.customerId === customerId).reduce((sum, row) => sum + (row.amountPaise || 0), 0));
    }
    draft.entries.forEach((_, index) => { const subtotal = root.querySelector(`[data-entry-total="${index}"]`); if (subtotal) subtotal.textContent = rupees(allocations.filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + (row.amountPaise || 0), 0)); });
  }
  function openCreate() {
    draft?.entries.forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
    draft = { operationId: uniqueId(), customers: [], allocations: new Map(), entries: [{ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null }], remarks: '', invoiceLoading: false, invoiceError: false };
    renderDraft(); $('collection-dialog').showModal(); refreshDraftInvoices();
  }
  async function refreshDraftInvoices() {
    const currentDraft = draft;
    if (!currentDraft || currentDraft.invoiceLoading) return;
    currentDraft.invoiceLoading = true; currentDraft.invoiceError = false; renderDraft();
    try {
      const fresh = await listInvoices(db, own());
      if (draft !== currentDraft) return;
      invoices = fresh;
      for (const [id] of currentDraft.allocations) if (!fresh.some((invoice) => invoice.id === id && invoiceAvailable(invoice))) currentDraft.allocations.delete(id);
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
      if (entryTotals.some((amount) => !amount)) throw new Error('Every payment entry needs an invoice allocation.');
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
        entries.push({ mode: entry.mode, transactionNumber: entry.mode === 'cash' ? '-' : entry.transactionNumber, attachment: entry.uploaded });
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
    }
    busy = true;
    try { await callOperation(functions, 'reviewCollection', { collectionId: id, decision, reason }); $('collection-dialog').close(); showToast(decision === 'verified' ? 'Collection approved.' : 'Collection rejected.'); await load(); }
    catch (error) { showToast(error.message, 'toast-error'); } finally { busy = false; }
  }
  async function showReceipt(id, index) {
    try {
      const result = await callOperation(functions, 'readCollectionReceipt', { collectionId: id, entryIndex: index }), url = readFile(result);
      const dialog = document.createElement('dialog'); dialog.className = 'app-dialog receipt-dialog';
      const title = document.createElement('h2'); title.textContent = 'Collection receipt'; dialog.append(title);
      const preview = document.createElement(result.contentType === 'application/pdf' ? 'iframe' : 'img'); preview.src = url; preview.title = 'Receipt preview'; preview.alt = 'Receipt preview'; dialog.append(preview);
      const link = document.createElement('a'); link.className = 'button button-primary'; link.href = url; link.download = result.name || 'receipt'; link.textContent = 'Download'; dialog.append(link);
      const close = document.createElement('button'); close.className = 'button button-outline'; close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(close);
      dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); }; document.body.append(dialog); dialog.showModal();
    } catch (error) { showToast(error.message, 'toast-error'); }
  }
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-empty-create]')) { $('payment-create').click(); return; }
    if (event.target.closest('[data-empty-bulk]')) { $('collection-create').click(); return; }
    const single = event.target.closest('[data-single-view],[data-single-approve],[data-single-reject]');
    if (single) {
      const id = single.dataset.singleView || single.dataset.singleApprove || single.dataset.singleReject;
      if (single.dataset.singleView) {
        const row = payments.find((item) => item.id === id); if (!row) return;
        $('collection-dialog-content').innerHTML = `<div class="dialog-header"><h2>Single Payment</h2><button id="single-close" class="icon-button" type="button" aria-label="Close">×</button></div><p>Reference: ${esc(row.transactionNumber || '—')}</p><p>Customer: ${esc(row.customerSnapshot?.fullName)} · Order: ${esc(row.orderNumber)} · Invoice: ${esc(row.invoiceNumber)}</p><p>Amount: ${rupees(row.amountPaise)} · Method: ${esc(paymentName(row.mode))}</p><p>Submitted by: ${esc(row.submittedByName || row.submittedBy)} · ${esc(dateTime(row.submittedAt))}</p><p>Status: ${esc(statusName(row.reversalId ? 'reversed' : row.verificationStatus === 'unverified' ? 'pending' : row.verificationStatus))}</p><p>Verified by: ${esc(row.verifiedByName || row.verifiedBy || '—')} · ${esc(dateTime(row.verifiedAt))}${row.receivedBy ? ` · Received by ${esc(row.receivedByName || row.receivedBy)}` : ''}</p>${row.remarks ? `<p>Remarks: ${esc(row.remarks)}</p>` : ''}${row.reviewReason ? `<p>Reason: ${esc(row.reviewReason)}</p>` : ''}<div class="dialog-actions">${row.attachment ? `<button type="button" data-single-receipt="${esc(id)}" class="button button-outline">Receipt</button>` : ''}<button id="single-done" type="button" class="button button-outline">Close</button></div>`;
        $('single-close').onclick = $('single-done').onclick = () => $('collection-dialog').close(); $('collection-dialog').showModal(); return;
      }
      document.dispatchEvent(new CustomEvent('oms:single-payment-action', { detail: { kind: single.dataset.singleApprove ? 'verify' : 'reject', id } })); return;
    }
    const receipt = event.target.closest('[data-single-receipt]'); if (receipt) { document.dispatchEvent(new CustomEvent('oms:single-payment-action', { detail: { kind: 'receipt', id: receipt.dataset.singleReceipt } })); return; }
    const target = event.target.closest('[data-collection-view],[data-collection-approve],[data-collection-reject],[data-collection-receipt],[data-remove-customer],[data-invoice-check],[data-entry-remove-file],[data-entry-remove]'); if (!target) return;
    if (target.dataset.collectionView) return view(target.dataset.collectionView);
    if (target.dataset.collectionApprove) return review(target.dataset.collectionApprove, 'verified');
    if (target.dataset.collectionReject) return review(target.dataset.collectionReject, 'rejected');
    if (target.dataset.collectionReceipt !== undefined) return showReceipt(viewingId, Number(target.dataset.collectionReceipt));
    if (!draft) return;
    if (target.dataset.removeCustomer) { const id = target.dataset.removeCustomer; draft.customers = draft.customers.filter((value) => value !== id); for (const invoice of invoices.filter((item) => item.customerId === id)) draft.allocations.delete(invoice.id); changed(); renderDraft(); }
    if (target.dataset.invoiceCheck) { const id = target.dataset.invoiceCheck; if (target.checked) draft.allocations.set(id, { amountPaise: 0, amountRaw: '', paymentIndex: 0 }); else draft.allocations.delete(id); changed(); renderDraft(); }
    if (target.dataset.entryRemoveFile !== undefined) { const entry = draft.entries[Number(target.dataset.entryRemoveFile)]; if (entry.url) URL.revokeObjectURL(entry.url); entry.file = null; entry.url = null; entry.uploaded = null; changed(); renderDraft(); }
    if (target.dataset.entryRemove !== undefined) { const index = Number(target.dataset.entryRemove); if (draft.allocations.size && [...draft.allocations.values()].some((item) => item.paymentIndex === index)) return showToast('Move invoice allocations to another payment entry first.', 'toast-error'); const [entry] = draft.entries.splice(index, 1); if (entry.url) URL.revokeObjectURL(entry.url); for (const row of draft.allocations.values()) if (row.paymentIndex > index) row.paymentIndex--; changed(); renderDraft(); }
  });
  root.addEventListener('change', (event) => {
    if (!draft) return; const target = event.target;
    if (target.dataset.invoiceEntry) { draft.allocations.get(target.dataset.invoiceEntry).paymentIndex = Number(target.value); changed(); renderDraft(); }
    if (target.dataset.invoiceAmount) renderDraft();
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
    if (target.dataset.invoiceAmount) { const row = draft.allocations.get(target.dataset.invoiceAmount); if (row) { row.amountRaw = target.value; row.amountPaise = /^\d+(?:\.\d{1,2})?$/.test(target.value) ? Math.round(Number(target.value) * 100) : NaN; } changed(); updateDraftSummary(); }
    if (target.dataset.entryReference !== undefined) { draft.entries[Number(target.dataset.entryReference)].transactionNumber = target.value; changed(); }
  });
  $('payment-create').onclick = () => document.dispatchEvent(new CustomEvent('oms:create-single-payment'));
  $('collection-create').onclick = openCreate; $('collection-refresh').onclick = load;
  for (const id of ['collection-search', 'collection-karyakarta', 'collection-customer', 'collection-type', 'collection-status', 'collection-from', 'collection-to']) $(id).addEventListener('input', renderList);
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'payments') load(); });
  document.addEventListener('oms:payment-changed', load);
  return { setSession(nextUser, nextProfile) { loadingRevision++; user = nextUser; profile = nextProfile; collections = []; payments = []; invoices = []; customers = []; if (user && profile) load(); else { $('collection-list').innerHTML = ''; $('collection-dialog').close(); } } };
}
