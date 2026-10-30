import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { listCollections, listInvoices } from './finance-data.js';
import { callOperation } from './operations-data.js';
import { isStaff, hasPermission } from './permissions.js';
import { uniqueId } from './unique-id.js';
import { showToast } from './ui.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '<': '&lt;', "'": '&#39;' })[char]);
const rupees = (paise) => `₹${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateTime = (stamp) => stamp?.toDate?.()?.toLocaleString('en-IN') || '';
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
    <div class="section-heading"><div><p class="eyebrow">KARYAKARTA COLLECTIONS</p><h2>Collections</h2></div><button id="collection-create" class="button button-primary" type="button">Create collection</button></div>
    <div id="collection-cards" class="ops-cards"></div><div class="card ops-panel"><div class="ops-toolbar"><input id="collection-search" type="search" placeholder="Collection number" aria-label="Search collection number"><input id="collection-karyakarta" type="search" placeholder="Karyakarta" aria-label="Filter Karyakarta"><input id="collection-customer" type="search" placeholder="Customer" aria-label="Filter customer"><select id="collection-status"><option value="">All statuses</option><option value="pending">Pending</option><option value="verified">Approved</option><option value="rejected">Rejected</option></select><input id="collection-from" type="date" aria-label="Collections from"><input id="collection-to" type="date" aria-label="Collections to"><button id="collection-refresh" class="button button-outline" type="button">Refresh</button></div><p id="collection-message" role="status"></p><div id="collection-list" class="collection-list"></div></div>
    <dialog id="collection-dialog" class="app-dialog collection-dialog" aria-label="Collection details"><div id="collection-dialog-content"></div></dialog>`;
  parent.append(root);
  const $ = (id) => root.querySelector(`#${id}`);
  let user = null, profile = null, collections = [], customers = [], invoices = [], draft = null, viewingId = null, loadingRevision = 0, busy = false;
  const own = () => isStaff(profile) ? null : user?.uid;
  const invoiceAvailable = (invoice) => invoice.customerId && invoice.totalPaise > invoice.verifiedPaidPaise && invoice.paymentStatus !== 'paid' && invoice.paymentStatus !== 'in_process';
  function renderList() {
    $('collection-cards').innerHTML = `<div class="card ops-stat"><span>Pending verification</span><strong>${collections.filter((row) => row.status === 'pending').length}</strong></div><div class="card ops-stat"><span>Approved collections</span><strong>${collections.filter((row) => row.status === 'verified').length}</strong></div><div class="card ops-stat"><span>Approved total</span><strong>${rupees(collections.reduce((sum, row) => sum + (row.approvedPaise || 0), 0))}</strong></div>`;
    const search = $('collection-search').value.trim().toLowerCase(), karyakarta = $('collection-karyakarta').value.trim().toLowerCase(), customer = $('collection-customer').value.trim().toLowerCase(), status = $('collection-status').value, from = $('collection-from').value, to = $('collection-to').value;
    const rows = collections.filter((row) => (!status || row.status === status) && (!from || row.collectionDate >= from) && (!to || row.collectionDate <= to)
      && (!search || String(row.collectionNumber || '').toLowerCase().includes(search)) && (!karyakarta || String(row.submittedByName || '').toLowerCase().includes(karyakarta)) && (!customer || row.allocations?.some((item) => String(item.customerName || '').toLowerCase().includes(customer))))
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
    $('collection-list').innerHTML = rows.length ? `<div class="table-scroll mobile-table"><table><thead><tr><th>Number</th><th>Date</th><th>Collected by</th><th>Customers</th><th>Invoices</th><th>Amount</th><th>Method</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.collectionNumber)}</td><td>${esc(row.collectionDate)}</td><td>${esc(row.submittedByName)}</td><td>${row.customerCount}</td><td>${row.invoiceCount}</td><td>${rupees(row.totalPaise)}</td><td>${esc(new Set(row.entries?.map((entry) => entry.mode)).size > 1 ? 'Mixed' : paymentName(row.entries?.[0]?.mode))}</td><td>${esc(statusName(row.status))}</td><td><button type="button" data-collection-view="${esc(row.id)}">View</button>${hasPermission(profile, 'verifyPayments') && row.status === 'pending' ? `<button type="button" data-collection-approve="${esc(row.id)}">Approve</button><button type="button" data-collection-reject="${esc(row.id)}">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="mobile-record-list">${rows.map((row) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(row.collectionNumber)}</strong><span class="mobile-status">${esc(statusName(row.status))}</span></div><p>${esc(row.submittedByName)}<small>${esc(row.collectionDate)} · ${row.customerCount} customers · ${row.invoiceCount} invoices · ${esc(new Set(row.entries?.map((entry) => entry.mode)).size > 1 ? 'Mixed' : paymentName(row.entries?.[0]?.mode))}</small></p><div class="mobile-record-bottom"><b>${rupees(row.totalPaise)}</b><div class="mobile-record-actions"><button type="button" data-collection-view="${esc(row.id)}">View</button>${hasPermission(profile, 'verifyPayments') && row.status === 'pending' ? `<button type="button" data-collection-approve="${esc(row.id)}">Approve</button><button type="button" data-collection-reject="${esc(row.id)}">Reject</button>` : ''}</div></div></article>`).join('')}</div>` : '<p class="muted">No collections match these filters.</p>';
  }
  async function load() {
    if (!user || !profile) return;
    const revision = ++loadingRevision, token = globalThis.omsLoading?.start('Loading collections…');
    try {
      const owner = own();
      const customerQuery = owner ? [query(collection(db, 'customers'), where('assignedUserId', '==', owner)), query(collection(db, 'customers'), where('ownerUserIds', 'array-contains', owner))] : [collection(db, 'customers')];
      const [collectionRows, invoiceRows, ...customerSnaps] = await Promise.all([listCollections(db, owner), listInvoices(db, owner), ...customerQuery.map((item) => getDocs(item))]);
      if (revision !== loadingRevision) return;
      collections = collectionRows; invoices = invoiceRows;
      customers = [...new Map(customerSnaps.flatMap((snap) => snap.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]))).values()];
      $('collection-message').textContent = ''; renderList();
    } catch (error) { if (revision === loadingRevision) $('collection-message').textContent = `Could not load collections: ${error.message}`; }
    finally { globalThis.omsLoading?.stop(token); }
  }
  const reference = () => `COL-${collectionDay().replaceAll('-', '')}-${draft.operationId.replaceAll('-', '').toUpperCase()}`;
  const paymentName = (mode) => ({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Online' })[mode] || mode;
  const statusName = (status) => ({ pending: 'Pending verification', verified: 'Approved', rejected: 'Rejected' })[status] || status;
  function draftTotals() {
    const allocations = [...draft.allocations.entries()].map(([invoiceId, row]) => ({ invoiceId, ...row }));
    return { allocations, total: allocations.reduce((sum, row) => sum + (row.amountPaise || 0), 0), customers: new Set(allocations.map((row) => invoices.find((invoice) => invoice.id === row.invoiceId)?.customerId)).size };
  }
  function renderDraft() {
    if (!draft) return;
    const selected = new Set(draft.customers), available = customers.filter((customer) => !selected.has(customer.id));
    const { allocations, total, customers: customerCount } = draftTotals();
    $('collection-dialog-content').innerHTML = `<div class="dialog-header"><h2>Create collection</h2><button id="collection-close" class="icon-button" type="button" aria-label="Close">×</button></div>
      <p><strong>${esc(reference())}</strong> · ${esc(collectionDay())} · Collected by ${esc(profile?.fullName || profile?.displayName || user.uid)}</p>
      <div class="collection-add"><select id="collection-customer-pick" aria-label="Add customer"><option value="">Select customer</option>${available.map((customer) => `<option value="${esc(customer.id)}">${esc(customer.fullName)} · ${esc(customer.contact)}</option>`).join('')}</select><button id="collection-add-customer" class="button button-outline" type="button">Add customer</button></div>
      ${draft.customers.map((customerId) => {
        const customer = customers.find((item) => item.id === customerId), rows = invoices.filter((invoice) => invoice.customerId === customerId && invoiceAvailable(invoice));
        const sum = rows.reduce((value, invoice) => value + (draft.allocations.get(invoice.id)?.amountPaise || 0), 0);
        return `<div class="collection-customer"><h3>${esc(customer?.fullName || 'Customer')} <small>${rupees(sum)}</small><button type="button" data-remove-customer="${esc(customerId)}" aria-label="Remove customer">×</button></h3>${rows.length ? rows.map((invoice) => {
          const row = draft.allocations.get(invoice.id), balance = invoice.totalPaise - invoice.verifiedPaidPaise;
          return `<div class="collection-invoice"><label><input type="checkbox" data-invoice-check="${esc(invoice.id)}" ${row ? 'checked' : ''}>${esc(invoice.invoiceNumber)} · ${esc(dateTime(invoice.issuedAt))}</label><small>Total ${rupees(invoice.totalPaise)} · Paid ${rupees(invoice.verifiedPaidPaise)} · Outstanding ${rupees(balance)}</small>${row ? `<div class="collection-allocation"><label>Collected ₹<input type="number" min="0.01" step="0.01" max="${(balance / 100).toFixed(2)}" data-invoice-amount="${esc(invoice.id)}" value="${esc(row.amountRaw ?? (row.amountPaise / 100).toFixed(2))}"></label><label>Payment entry<select data-invoice-entry="${esc(invoice.id)}">${draft.entries.map((entry, index) => `<option value="${index}" ${row.paymentIndex === index ? 'selected' : ''}>${index + 1}: ${paymentName(entry.mode)}</option>`).join('')}</select></label></div>` : ''}</div>`;
        }).join('') : '<p class="muted">No unpaid invoices available for this customer.</p>'}</div>`;
      }).join('')}
      <h3>Payment entries</h3>${draft.entries.map((entry, index) => `<div class="collection-entry"><h4>Entry ${index + 1} · ${rupees(allocations.filter((row) => row.paymentIndex === index).reduce((sum, row) => sum + row.amountPaise, 0))}</h4><label>Method<select data-entry-mode="${index}"><option value="cash" ${entry.mode === 'cash' ? 'selected' : ''}>Cash</option><option value="upi" ${entry.mode === 'upi' ? 'selected' : ''}>UPI</option><option value="bank_transfer" ${entry.mode === 'bank_transfer' ? 'selected' : ''}>Online</option></select></label><label>Transaction ID<input data-entry-reference="${index}" maxlength="100" value="${esc(entry.transactionNumber || '')}" ${entry.mode === 'cash' ? 'disabled' : ''}></label><label>Receipt (JPG, PNG or PDF, max 5 MB)<input type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" data-entry-file="${index}"></label>${entry.file ? `<p>${esc(entry.file.name)} · ${(entry.file.size / 1024 / 1024).toFixed(2)} MB <button type="button" data-entry-remove-file="${index}">Remove</button></p><div class="collection-file-preview">${entry.file.type === 'application/pdf' ? `<iframe title="Receipt preview" src="${entry.url}"></iframe>` : `<img alt="Receipt preview" src="${entry.url}">`}</div>` : ''}<p id="collection-progress-${index}" role="status"></p>${draft.entries.length > 1 ? `<button type="button" data-entry-remove="${index}">Remove entry</button>` : ''}</div>`).join('')}<button id="collection-add-entry" class="button button-outline" type="button">Add payment entry</button>
      <label class="ops-field">Remarks<textarea id="collection-remarks" maxlength="1000">${esc(draft.remarks)}</textarea></label><div class="collection-summary"><strong>Summary before submission</strong><p>${customerCount} customers · ${allocations.length} invoices · Grand total ${rupees(total)}</p>${draft.customers.map((id) => { const customer = customers.find((item) => item.id === id); const sum = allocations.filter((row) => invoices.find((invoice) => invoice.id === row.invoiceId)?.customerId === id).reduce((value, row) => value + row.amountPaise, 0); return sum ? `<p>${esc(customer?.fullName)} — ${rupees(sum)}</p>` : ''; }).join('')}</div><p id="collection-error" class="form-error" role="alert"></p><div class="dialog-actions"><button id="collection-cancel" type="button" class="button button-outline">Cancel</button><button id="collection-submit" type="button" class="button button-primary">Submit for verification</button></div>`;
    $('collection-close').onclick = $('collection-cancel').onclick = () => $('collection-dialog').close();
    $('collection-add-customer').onclick = () => { const id = $('collection-customer-pick').value; if (id) { draft.customers.push(id); changed(); renderDraft(); } };
    $('collection-add-entry').onclick = () => { if (draft.entries.length >= 20) return; draft.entries.push({ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null }); changed(); renderDraft(); };
    $('collection-remarks').oninput = (event) => { draft.remarks = event.target.value; changed(); };
    $('collection-submit').onclick = submit;
  }
  function changed() {
    if (draft.entries.some((entry) => entry.uploaded)) { draft.operationId = uniqueId(); draft.entries.forEach((entry) => { entry.uploaded = null; }); }
  }
  function openCreate() {
    draft?.entries.forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
    draft = { operationId: uniqueId(), customers: [], allocations: new Map(), entries: [{ mode: 'cash', transactionNumber: '', file: null, url: null, uploaded: null }], remarks: '' };
    renderDraft(); $('collection-dialog').showModal();
  }
  async function submit() {
    if (busy || !draft) return;
    const { allocations, total } = draftTotals();
    try {
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
      $('collection-dialog').close(); showToast(`${result.collectionNumber} submitted for verification.`); draft = null; await load();
    } catch (error) { $('collection-error').textContent = error.message || 'Collection could not be submitted. Retry.'; }
    finally { busy = false; if ($('collection-submit')) $('collection-submit').disabled = false; }
  }
  async function view(id) {
    const row = collections.find((item) => item.id === id); if (!row) return;
    viewingId = id;
    const grouped = new Map(); for (const item of row.allocations) { if (!grouped.has(item.customerId)) grouped.set(item.customerId, []); grouped.get(item.customerId).push(item); }
    const content = $('collection-dialog-content');
    content.innerHTML = `<div class="dialog-header"><h2>${esc(row.collectionNumber)}</h2><button id="collection-detail-close" class="icon-button" type="button" aria-label="Close">×</button></div><p>${esc(row.collectionDate)} · ${esc(statusName(row.status))} · Collected by ${esc(row.submittedByName)} · Submitted ${esc(dateTime(row.submittedAt))}</p><p>Verified by ${esc(row.verifiedByName || '—')} · ${esc(dateTime(row.verifiedAt))}</p>${row.rejectionReason ? `<p>Rejection reason: ${esc(row.rejectionReason)}</p>` : ''}
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
    if (target.dataset.invoiceAmount) { const row = draft.allocations.get(target.dataset.invoiceAmount); if (row) { row.amountRaw = target.value; row.amountPaise = /^\d+(?:\.\d{1,2})?$/.test(target.value) ? Math.round(Number(target.value) * 100) : NaN; } changed(); const summary = root.querySelector('.collection-summary'); if (summary) summary.querySelector('p').textContent = `${draftTotals().customers} customers · ${draftTotals().allocations.length} invoices · Grand total ${rupees(draftTotals().total)}`; }
    if (target.dataset.entryReference !== undefined) { draft.entries[Number(target.dataset.entryReference)].transactionNumber = target.value; changed(); }
  });
  $('collection-create').onclick = openCreate; $('collection-refresh').onclick = load;
  for (const id of ['collection-search', 'collection-karyakarta', 'collection-customer', 'collection-status', 'collection-from', 'collection-to']) $(id).addEventListener('input', renderList);
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'payments') load(); });
  return { setSession(nextUser, nextProfile) { loadingRevision++; user = nextUser; profile = nextProfile; collections = []; invoices = []; customers = []; if (user && profile) load(); else { $('collection-list').innerHTML = ''; $('collection-dialog').close(); } } };
}
