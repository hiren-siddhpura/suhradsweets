import { hasPermission, isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { getFreshInvoice, listInvoices, listPayments } from './finance-data.js';
import { createInvoicePdfBlob, downloadInvoicePdf, invoicePreviewHtml } from './invoice-pdf.js';
import { shareInvoicePdf } from './invoice-share.js';
import { readBusinessDetails } from './master-data.js';
import { downloadXlsx } from './xlsx-export.js';
import { actionLabel, activityDate, changeSummary, references } from './activity-format.js';
import { listActivity } from './activity-data.js';
import { uniqueId } from './unique-id.js';
import { paymentInvoiceSummary, paymentUpload } from './payment-form-ui.js';
import { listMasterRecords } from './master-data.js';
import { sortUsersByName } from './user-sort.js';
import { listOrders, listCustomers } from './order-data.js';
import { cardIcon, cardButton, cardMore } from './mobile-card.js';
import { getStorage, ref as storageRef, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const cash = (paise) => `₹${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (stamp) => stamp?.toDate?.()?.toLocaleString('en-IN') || '';
const iso = (stamp) => stamp?.toDate?.()?.toISOString().slice(0, 10) || '';
const message = (error) => error?.message?.replace(/^.*?: /, '') || 'Operation failed.';
const stat = (label, value) => `<div class="card ops-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

async function exportRows(name, rows) {
  try {
    await downloadXlsx(name.toLowerCase(), [[name, rows]]);
  } catch { showToast('XLSX export could not load.', 'toast-error'); }
}

export function initFinanceUi({ db, functions }) {
  let user = null, profile = null, invoices = [], payments = [], paymentUsers = [], invoiceCustomers = [], orderAssignees = new Map(), paymentsLoaded = false, revision = 0, action = '', target = '', resolvedNames = new Map(), paymentOperationId = '', paymentPage = 1;
  let appliedPaymentFilters = {};
  const paymentFilterIds = ['search', 'user', 'customer', 'mode', 'status', 'from', 'to', 'order', 'invoice', 'submitter', 'verifier'];
  const readPaymentFilters = () => Object.fromEntries(paymentFilterIds.map((field) => [field, String($(`payment-${field}`).value || '').trim()]));
  let recordLoadToken = null, activityLoadToken = null;
  const stopRecordLoad = () => { if (recordLoadToken) globalThis.omsLoading?.stop(recordLoadToken); recordLoadToken = null; };
  const stopActivityLoad = () => { if (activityLoadToken) globalThis.omsLoading?.stop(activityLoadToken); activityLoadToken = null; };
  const pendingFinance = new Set();
  let previewInvoice = null, previewBlob = null, previewRevision = 0;
  let receiptFile = null, receiptUrl = null, receiptUpload = null, uploadedReceipt = null;
  const clearReceipt = () => { receiptUpload?.cancel(); receiptUpload = null; receiptFile = null; uploadedReceipt = null; if (receiptUrl) URL.revokeObjectURL(receiptUrl); receiptUrl = null; };
  const receiptExtension = (file) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' })[file?.type];
  const validReceipt = (file) => {
    const extension = receiptExtension(file);
    if (!extension || !new RegExp(`\\.${extension === 'jpg' ? 'jpe?g' : extension}$`, 'i').test(file.name)) throw new Error('Choose a JPG, JPEG, PNG or PDF receipt.');
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Receipt must be at most 5 MB.');
    return extension;
  };
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const privileged = () => isStaff(profile);
  const canVerify = () => hasPermission(profile, 'verifyPayments');
  const paymentName = (row, field) => {
    const uid = row[field]; if (!uid) return '—';
    const snapshot = row[`${field}Name`];
    return snapshot || resolvedNames.get(row.id)?.[`${field}Name`] || (uid === user?.uid ? profile?.fullName || profile?.displayName : '') || 'Unknown user';
  };
  const customerName = (row) => row.customerSnapshot?.fullName || resolvedNames.get(row.id)?.customerName || 'Unknown customer';
  const invoiceStatus = (row) => row.status === 'cancelled' || row.paymentStatus === 'cancelled' ? 'cancelled' : row.paymentStatus === 'overpaid' || row.verifiedPaidPaise > row.totalPaise ? 'overpaid' : row.paymentStatus === 'paid' || row.paymentStatus === 'ready_to_mark_paid' && row.verifiedPaidPaise === row.totalPaise ? 'paid'
    : payments.some((payment) => payment.invoiceId === row.id && payment.verificationStatus === 'unverified') ? 'in_process' : row.paymentStatus;
  const statusLabel = (status) => ({ unpaid: 'Unpaid', partial: 'Partially Paid', in_process: 'In process', ready_to_mark_paid: 'Ready to mark paid', paid: 'Paid', overpaid: 'Overpaid / credit review', cancelled: 'Cancelled' })[status] || status || 'Unknown';
  const statusBadge = (status) => `<span class="status-badge is-${esc(String(status || 'unknown').replace(/_/g, '-'))}">${esc(statusLabel(status))}</span>`;
  const invoiceAssignee = (row) => orderAssignees.get(row.orderId) || row.ownerUid;
  const matching = (kind) => {
    const rows = kind === 'invoice' ? invoices : payments;
    const filters = kind === 'payment' ? appliedPaymentFilters : null;
    const search = (filters?.search ?? $(`${kind}-search`).value).trim().toLowerCase(), status = filters?.status ?? $(`${kind}-status`).value, from = filters?.from ?? $(`${kind}-from`).value, to = filters?.to ?? $(`${kind}-to`).value;
    const extra = kind === 'payment' ? Object.fromEntries(['customer', 'order', 'invoice', 'mode', 'submitter', 'verifier'].map((field) => [field, String(filters?.[field] || '').toLowerCase()])) : {};
    const invoiceUser = kind === 'invoice' ? $('invoice-user').value : '', invoiceCustomer = kind === 'invoice' ? $('invoice-customer').value : '';
    return rows.filter((row) => {
      const haystack = `${row.invoiceNumber} ${row.orderNumber} ${row.customerSnapshot?.fullName} ${row.customerSnapshot?.contact} ${row.transactionNumber || ''} ${kind === 'payment' ? `${customerName(row)} ${paymentName(row, 'submittedBy')} ${paymentName(row, 'verifiedBy')}` : ''}`.toLowerCase();
      const day = iso(kind === 'invoice' ? row.issuedAt : row.submittedAt);
      return (!search || haystack.includes(search)) && (!status || (kind === 'invoice' ? invoiceStatus(row) : row.reversalId ? 'reversed' : row.verificationStatus) === status) && (!from || day >= from) && (!to || day <= to)
        && (kind !== 'invoice' || (!invoiceUser || invoiceAssignee(row) === invoiceUser) && (!invoiceCustomer || row.customerId === invoiceCustomer))
        && (kind !== 'payment' || (!filters?.user || row.ownerUid === filters.user)
          && (!extra.customer || `${customerName(row)} ${row.customerSnapshot?.contact || ''}`.toLowerCase().includes(extra.customer))
          && (!extra.order || String(row.orderNumber || '').toLowerCase().includes(extra.order))
          && (!extra.invoice || String(row.invoiceNumber || '').toLowerCase().includes(extra.invoice))
          && (!extra.mode || row.mode === extra.mode)
          && (!extra.submitter || paymentName(row, 'submittedBy').toLowerCase().includes(extra.submitter))
          && (!extra.verifier || paymentName(row, 'verifiedBy').toLowerCase().includes(extra.verifier)));
    }).sort((a, b) => (kind === 'invoice' ? b.issuedAt?.seconds - a.issuedAt?.seconds : b.submittedAt?.seconds - a.submittedAt?.seconds) || 0);
  };
  function renderInvoices() {
    const rows = matching('invoice');
    $('invoice-cards').innerHTML = stat('Visible invoices', rows.length) + stat('Outstanding', cash(rows.filter((row) => invoiceStatus(row) !== 'cancelled').reduce((sum, row) => sum + Math.max(0, row.totalPaise - row.verifiedPaidPaise), 0))) + stat('Verified payments', cash(rows.filter((row) => invoiceStatus(row) !== 'cancelled').reduce((sum, row) => sum + row.verifiedPaidPaise, 0)));
    $('invoice-body').innerHTML = rows.length ? rows.map((row) => {
      const status = invoiceStatus(row);
      return `<tr><td>${esc(row.invoiceNumber || `INV-${row.orderNumber}`)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.customerSnapshot?.fullName)}</td><td>${esc(date(row.issuedAt))}</td><td>${esc(cash(row.totalPaise))}</td><td>${esc(cash(row.verifiedPaidPaise))}</td><td>${esc(cash(row.totalPaise - row.verifiedPaidPaise))}</td><td>${statusBadge(status)}</td><td class="ops-actions"><button type="button" data-finance="preview" data-id="${esc(row.id)}">Preview / Print</button><button type="button" data-finance="pdf" data-id="${esc(row.id)}">PDF</button><button type="button" data-finance="share" data-id="${esc(row.id)}">Share on WhatsApp</button>${paymentsLoaded && !['paid', 'in_process', 'cancelled', 'overpaid'].includes(status) && row.totalPaise > row.verifiedPaidPaise && (canVerify() || row.ownerUid === user?.uid) ? `<button type="button" data-finance="submit" data-id="${esc(row.id)}">Add payment</button>` : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="9" class="empty-cell">No invoices match your access or filters.</td></tr>';
    if (!rows.length && !invoices.length) $('invoice-body').innerHTML = '<tr><td colspan="9" class="empty-cell">No invoice has been created yet. An Admin or Account Admin must choose Create invoice on a confirmed order.</td></tr>';
    $('invoice-mobile-list').innerHTML = rows.length ? rows.map((row) => {
      const status = invoiceStatus(row);
      const owner = paymentUsers.find((entry) => entry.id === row.ownerUid);
      const ownerName = row.assignedUserName || owner?.displayName || owner?.fullName || owner?.name;
      const payable = paymentsLoaded && !['paid', 'in_process', 'cancelled', 'overpaid'].includes(status) && row.totalPaise > row.verifiedPaidPaise && (canVerify() || row.ownerUid === user?.uid);
      const editName = profile?.role === 'admin' && status !== 'cancelled' ? `<button type="button" class="invoice-customer-edit" data-finance="invoiceDetails" data-id="${esc(row.id)}" aria-label="Edit invoice details for ${esc(row.invoiceNumber || row.orderNumber)}" title="Edit invoice details">${cardIcon('edit')}</button>` : '';
      return `<article class="order-mobile-card"><div class="order-card-header"><strong>${esc(row.invoiceNumber || `INV-${row.orderNumber}`)}</strong>${statusBadge(status)}</div><h3 class="order-card-customer invoice-card-customer"><span>${esc(row.customerSnapshot?.fullName || 'Customer unavailable')}</span>${editName}</h3><div class="order-card-meta"><span>${cardIcon('calendar')}${esc(date(row.issuedAt))}</span>${ownerName ? `<span>${cardIcon('user')}${esc(ownerName)}</span>` : ''}<span>${cardIcon('order')}${esc(row.orderNumber)}</span></div><div class="mobile-card-balances"><span>Paid <b>${esc(cash(row.verifiedPaidPaise))}</b></span><span>Outstanding <b>${esc(cash(Math.max(0, row.totalPaise - row.verifiedPaidPaise)))}</b></span></div><div class="order-card-total"><span>Invoice Total</span><strong>${esc(cash(row.totalPaise))}</strong></div><div class="order-card-actions">${cardButton('preview', row.id, 'View invoice', 'view', 'data-finance', 'View')}${cardButton('pdf', row.id, 'Download invoice', 'download', 'data-finance', 'Download')}${payable ? cardButton('submit', row.id, 'Record payment', 'payment', 'data-finance', 'Payment') : ''}${cardButton('share', row.id, 'Share invoice', 'share')}</div></article>`;
    }).join('') : '<p class="mobile-record-empty">No invoices match the current filters.</p>';
    if (profile?.role === 'admin') {
      for (const containerId of ['invoice-body']) {
        $(containerId).querySelectorAll?.('[data-finance="preview"]').forEach((button) => {
          const row = rows.find((entry) => entry.id === button.dataset.id);
          if (row && invoiceStatus(row) !== 'cancelled') button.insertAdjacentHTML('beforebegin', `<button type="button" data-finance="invoiceDetails" data-id="${esc(row.id)}">${cardIcon('edit')} Edit Invoice Details</button>`);
        });
      }
    }
  }
  function renderPayments() {
    const rows = matching('payment');
    const pageCount = Math.max(1, Math.ceil(rows.length / 25));
    paymentPage = Math.min(paymentPage, pageCount);
    const visibleRows = rows.slice((paymentPage - 1) * 25, paymentPage * 25);
    const collected = rows.filter((row) => row.verificationStatus === 'verified' && !row.reversalId);
    $('payment-cards').innerHTML = stat('Submissions', rows.length) + stat('Awaiting review', rows.filter((row) => row.verificationStatus === 'unverified').length) + stat('Online collection (verified)', cash(collected.filter((row) => row.mode === 'upi' || row.mode === 'bank_transfer').reduce((sum, row) => sum + row.amountPaise, 0))) + stat('Cash collection (verified)', cash(collected.filter((row) => row.mode === 'cash').reduce((sum, row) => sum + row.amountPaise, 0)));
    $('payment-body').innerHTML = visibleRows.length ? visibleRows.map((row) => `<tr><td>${esc(date(row.submittedAt))}</td><td>${esc(customerName(row))}</td><td>${esc(row.customerSnapshot?.contact)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.invoiceNumber)}</td><td>${esc(cash(row.amountPaise))}</td><td>${esc(row.mode)}</td><td>${esc(row.transactionNumber)}</td><td>${esc(paymentName(row, 'submittedBy'))}</td><td>${esc(row.reversalId ? 'reversed' : row.verificationStatus)}</td><td>${esc(paymentName(row, 'verifiedBy'))}${row.receivedBy ? `<small>Received: ${esc(paymentName(row, 'receivedBy'))}</small>` : ''}</td><td class="ops-actions">${row.attachment ? `<button type="button" data-finance="receipt" data-id="${esc(row.id)}">Receipt</button>` : ''}${canVerify() && row.verificationStatus === 'unverified' ? `<button type="button" data-finance="verify" data-id="${esc(row.id)}">Verify</button><button type="button" data-finance="reject" data-id="${esc(row.id)}">Reject</button>` : ''}${canVerify() && row.verificationStatus === 'verified' && !row.reversalId && !row.collectionId ? `<button type="button" data-finance="reverse" data-id="${esc(row.id)}">Reverse</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="13" class="empty-cell">No payments match your access or filters.</td></tr>';
    if (!rows.length && !payments.length) $('payment-body').innerHTML = '<tr><td colspan="13" class="empty-cell">No payment has been submitted yet. Open an invoice and select Add payment.</td></tr>';
    $('payment-body').querySelectorAll?.('tr').forEach((tr, index) => {
      if (!visibleRows[index]) { tr.querySelector('td')?.setAttribute('colspan', '13'); return; }
      tr.querySelector('td:last-child')?.insertAdjacentHTML('beforebegin', `<td>${esc(date(visibleRows[index].verifiedAt))}</td>`);
    });
    if (canVerify()) $('payment-body').querySelectorAll?.('[data-finance="verify"]').forEach((button) => button.insertAdjacentHTML('beforebegin', `<button type="button" data-finance="correct" data-id="${esc(button.dataset.id)}">Correct mode</button>`));
    $('payment-mobile-list').innerHTML = visibleRows.length ? visibleRows.map((row) => {
      const status = row.reversalId ? 'reversed' : row.verificationStatus;
      const extras = [canVerify() && status === 'unverified' ? `<button type="button" data-finance="correct" data-id="${esc(row.id)}">Correct mode</button>` : '', canVerify() && status === 'verified' && !row.collectionId ? `<button type="button" data-finance="reverse" data-id="${esc(row.id)}">Reverse payment</button>` : ''].filter(Boolean);
      return `<article class="order-mobile-card"><div class="order-card-header"><strong>${esc(row.transactionNumber || row.collectionNumber || row.invoiceNumber || 'Payment')}</strong><span class="mobile-status is-${esc(status)}">${esc(status)}</span></div><h3 class="order-card-customer">${esc(customerName(row))}</h3><div class="order-card-meta"><span>${cardIcon('calendar')}${esc(date(row.submittedAt))}</span><span>${cardIcon('payment')}${esc(({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Online' })[row.mode] || row.mode || 'Mode unavailable')}</span><span>${cardIcon('invoice')}${esc(row.invoiceNumber)}</span>${row.collectionNumber ? `<span>${cardIcon('receipt')}Collection ${esc(row.collectionNumber)}</span>` : ''}</div>${row.reviewReason ? `<p class="mobile-card-note">${esc(row.reviewReason)}</p>` : ''}<div class="order-card-total"><span>Payment Amount</span><strong>${esc(cash(row.amountPaise))}</strong></div><div class="order-card-actions">${cardButton('paymentDetails', row.id, 'View payment', 'view')}${row.attachment ? cardButton('receipt', row.id, 'View receipt', 'receipt') : ''}${canVerify() && status === 'unverified' ? cardButton('verify', row.id, 'Approve payment', 'check') + cardButton('reject', row.id, 'Reject payment', 'reject') : ''}${cardMore(esc(row.transactionNumber || row.invoiceNumber), extras)}</div></article>`;
    }).join('') : '<p class="mobile-record-empty">No payments match the current filters.</p>';
    visibleRows.forEach((row, index) => {
      if (row.collectionNumber) {
        $('payment-body').querySelectorAll('tr')[index]?.querySelectorAll('td')[4]?.insertAdjacentHTML('beforeend', `<small>Collection: ${esc(row.collectionNumber)}</small>`);
      }
      if (row.reviewReason) {
        $('payment-body').querySelectorAll('tr')[index]?.querySelectorAll('td')[9]?.insertAdjacentHTML('beforeend', `<small>${esc(row.reviewReason)}</small>`);
      }
    });
    if ($('payment-page')) { $('payment-page').textContent = `Page ${paymentPage} of ${pageCount}`; $('payment-prev').disabled = paymentPage === 1; $('payment-next').disabled = paymentPage >= pageCount; }
  }
  async function refresh() {
    if (!user || !profile) return;
    const current = ++revision, owner = privileged() ? null : user.uid;
    $('invoice-message').textContent = ''; $('payment-message').textContent = '';
    stopRecordLoad();
    const activePage = document.querySelector?.('[data-page].is-active')?.dataset.page;
    const token = ['invoices', 'payments'].includes(activePage) ? globalThis.omsLoading?.start('Loading invoices and payments…') || null : null;
    recordLoadToken = token;
    try {
    const [invoiceResult, paymentResult, usersResult, customerResult, orderResult] = await Promise.allSettled([listInvoices(db, owner), listPayments(db, owner), privileged() ? listMasterRecords(db, 'users') : Promise.resolve([{ id: user.uid, displayName: profile?.displayName || profile?.fullName || profile?.name || 'My payments' }]), listCustomers(db, owner), listOrders(db, owner)]);
    if (current !== revision) return;
    invoices = invoiceResult.status === 'fulfilled' ? invoiceResult.value : [];
    payments = paymentResult.status === 'fulfilled' ? paymentResult.value : [];
    paymentsLoaded = paymentResult.status === 'fulfilled';
    paymentUsers = usersResult.status === 'fulfilled' ? sortUsersByName(usersResult.value.filter((row) => row.active !== false)) : [];
    invoiceCustomers = customerResult.status === 'fulfilled' ? customerResult.value : [];
    orderAssignees = new Map(orderResult.status === 'fulfilled' ? orderResult.value.map((row) => [row.id, row.assignedUserId || row.ownerUid]) : []);
    const selectedInvoiceUser = $('invoice-user').value, selectedInvoiceCustomer = $('invoice-customer').value;
    const assignableUsers = paymentUsers.filter((row) => ['admin', 'account_admin', 'user'].includes(row.role || 'user'));
    $('invoice-user').innerHTML = `<option value="">All Users</option>${assignableUsers.map((row) => `<option value="${esc(row.id)}">${esc(row.displayName || row.fullName || row.name || row.email || row.id)}</option>`).join('')}`;
    $('invoice-user').value = selectedInvoiceUser;
    for (const row of invoices) if (row.customerId && !invoiceCustomers.some((customer) => customer.id === row.customerId)) invoiceCustomers.push({ id: row.customerId, fullName: row.customerSnapshot?.fullName || row.customerId });
    $('invoice-customer').innerHTML = `<option value="">All Customers</option>${invoiceCustomers.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''))).map((row) => `<option value="${esc(row.id)}">${esc(row.fullName || row.name || row.id)}</option>`).join('')}`;
    $('invoice-customer').value = selectedInvoiceCustomer;
    const selectedUser = $('payment-user').value;
    $('payment-user').innerHTML = `<option value="">All users</option>${paymentUsers.map((row) => `<option value="${esc(row.id)}">${esc(row.displayName || row.fullName || row.name || row.email || row.id)}</option>`).join('')}`;
    $('payment-user').value = selectedUser;
    resolvedNames = new Map();
    if (paymentResult.status === 'fulfilled') {
      for (let offset = 0; offset < payments.length; offset += 100) {
        try {
          const result = await callOperation(functions, 'getPaymentNames', { paymentIds: payments.slice(offset, offset + 100).map((row) => row.id) });
          for (const entry of result?.payments || []) resolvedNames.set(entry.paymentId, entry);
        } catch { /* Stored snapshots and safe fallbacks keep history readable. */ }
      }
    }
    if (current !== revision) return;
    renderInvoices(); renderPayments();
    if (document.querySelector?.('[data-page].is-active')?.dataset.page === 'payments') document.dispatchEvent(new Event('oms:payment-changed'));
    $('invoice-message').textContent = invoiceResult.status === 'rejected' ? `Could not load invoices: ${message(invoiceResult.reason)}`
      : paymentResult.status === 'rejected' ? 'Could not check payment submissions. Refresh before adding a payment.' : '';
    $('payment-message').textContent = paymentResult.status === 'rejected' ? `Could not load payments: ${message(paymentResult.reason)}` : '';
    } finally { if (recordLoadToken === token) stopRecordLoad(); }
  }
  function openDialog(kind, id) {
    clearReceipt();
    action = kind; target = id; $('finance-error').hidden = true;
    const invoice = invoices.find((row) => row.id === id);
    if (kind === 'submit') paymentOperationId = uniqueId();
    const payment = payments.find((row) => row.id === id);
    const outstanding = invoice ? (invoice.totalPaise - invoice.verifiedPaidPaise) / 100 : 0;
    $('finance-dialog').classList.toggle('payment-entry-dialog', kind === 'submit');
    $('finance-save').textContent = kind === 'submit' ? 'Submit for Verification' : 'Save';
    $('finance-dialog-title').textContent = ({ submit: 'Submit payment', correct: 'Correct payment mode', reject: 'Reject payment', reverse: 'Reverse verified payment' })[kind];
    $('finance-fields').innerHTML = kind === 'submit' ? `${paymentInvoiceSummary(invoice)}<div class="payment-form-grid"><label class="ops-field">Payment amount (₹)<input name="amount" type="number" min="0.01" step="0.01" max="${outstanding.toFixed(2)}" value="${outstanding.toFixed(2)}" required></label><label class="ops-field">Payment method<select name="mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Online</option></select></label></div><label class="ops-field payment-reference-field">Transaction ID<input name="reference" maxlength="100" placeholder="Enter transaction ID"></label><p class="payment-form-note">Payments count toward the balance after verification.</p>` : kind === 'correct' ? `<p>Current mode: ${esc(payment?.mode)} · Reference: ${esc(payment?.transactionNumber)}</p><label class="ops-field">New mode<select name="mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ops-field">New transaction reference<input name="reference" maxlength="100" placeholder="Cash uses -"></label><label class="ops-field">Reason<textarea name="reason" maxlength="500" required></textarea></label>` : '<label class="ops-field">Reason<textarea name="reason" maxlength="500" required></textarea></label>';
    if (kind === 'invoiceDetails') {
      $('finance-dialog-title').textContent = 'Edit Invoice Details';
      $('finance-fields').innerHTML = `<p>Invoice <strong>${esc(invoice.invoiceNumber)}</strong>. Changes apply only to this invoice.</p><label class="ops-field">Customer Name<input name="fullName" maxlength="120" value="${esc(invoice.customerSnapshot?.fullName)}" required></label><label class="ops-field">Contact Number<input name="contact" maxlength="80" value="${esc(invoice.customerSnapshot?.contact)}" required></label><label class="ops-field">Area<input name="area" maxlength="100" value="${esc(invoice.customerSnapshot?.area)}"></label><label class="ops-field">Address<textarea name="address" maxlength="300" rows="2">${esc(invoice.customerSnapshot?.address)}</textarea></label>`;
    }
    $('finance-dialog').showModal();
    if (kind === 'submit') {
      $('finance-fields').insertAdjacentHTML('beforeend', `${paymentUpload({ id: 'payment-proof' })}<div id="payment-proof-info" class="payment-proof-info" role="status"></div><div id="payment-proof-preview"></div><button id="payment-proof-remove" class="button button-outline" type="button" hidden>Remove</button><label class="ops-field">Remarks <small>Optional</small><textarea name="remarks" maxlength="1000" rows="3" placeholder="Add a note about this payment"></textarea></label><div id="payment-submit-summary" class="payment-submit-summary" role="status"></div>`);
      $('payment-proof').onchange = (event) => {
        if (uploadedReceipt) paymentOperationId = uniqueId();
        clearReceipt();
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          validReceipt(file); receiptFile = file; receiptUrl = URL.createObjectURL(file);
          $('payment-proof-info').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
          $('payment-proof-preview').innerHTML = file.type === 'application/pdf' ? `<iframe title="Receipt preview" src="${receiptUrl}"></iframe>` : `<img alt="Receipt preview" src="${receiptUrl}">`;
          $('payment-proof-remove').hidden = false;
        } catch (error) { $('payment-proof-info').textContent = error.message; event.target.value = ''; }
      };
      $('payment-proof-remove').onclick = () => { if (uploadedReceipt) paymentOperationId = uniqueId(); clearReceipt(); $('payment-proof').value = ''; $('payment-proof-info').textContent = ''; $('payment-proof-preview').replaceChildren(); $('payment-proof-remove').hidden = true; };
      const mode = $('finance-fields').querySelector('[name="mode"]');
      const updateRequirement = () => { const online = mode.value !== 'cash'; $('payment-proof').required = online; const reference = $('finance-fields').querySelector('[name="reference"]'); reference.required = online; reference.closest('label').hidden = !online; updateSummary(); };
      const updateSummary = () => { const amount = Number($('finance-fields').querySelector('[name="amount"]').value || 0); $('payment-submit-summary').textContent = `Submit ${cash(Math.round(amount * 100))} by ${{ cash: 'Cash', upi: 'UPI', bank_transfer: 'Online' }[mode.value]} for verification.`; };
      $('finance-fields').querySelector('[name="amount"]').addEventListener('input', updateSummary);
      mode.addEventListener('change', updateRequirement); updateRequirement();
    }
  }
  async function act(kind, id) {
    try {
      if (['verify', 'reject', 'reverse', 'correct'].includes(kind) && !canVerify()) throw new Error('Access denied: payment review requires a privileged OMS role.');
      if (kind === 'paymentDetails') {
        const row = payments.find((payment) => payment.id === id);
        if (!row) throw new Error('Payment is unavailable. Refresh and try again.');
        const dialog = document.createElement('dialog'); dialog.className = 'app-dialog';
        dialog.innerHTML = `<div class="dialog-header"><h2>Payment ${esc(row.transactionNumber || row.invoiceNumber || '')}</h2><button type="button" data-close class="icon-button" aria-label="Close">×</button></div><p><strong>Customer:</strong> ${esc(customerName(row))}</p><p><strong>Invoice:</strong> ${esc(row.invoiceNumber)} · <strong>Order:</strong> ${esc(row.orderNumber)}</p><p><strong>Date:</strong> ${esc(date(row.submittedAt))} · <strong>Mode:</strong> ${esc(row.mode)}</p><p><strong>Amount:</strong> ${esc(cash(row.amountPaise))} · <strong>Status:</strong> ${esc(row.reversalId ? 'reversed' : row.verificationStatus)}</p>${row.collectionNumber ? `<p><strong>Collection:</strong> ${esc(row.collectionNumber)}</p>` : ''}${row.reviewReason ? `<p><strong>Reason:</strong> ${esc(row.reviewReason)}</p>` : ''}`;
        dialog.insertAdjacentHTML('beforeend', `<p><strong>Reviewed by:</strong> ${esc(paymentName(row, 'verifiedBy') || '—')} · ${esc(date(row.verifiedAt) || '—')}</p><div class="dialog-actions">${canVerify() && row.verificationStatus === 'unverified' ? '<button type="button" data-review="verify" class="button button-approve">Approve</button><button type="button" data-review="reject" class="button button-reject">Reject</button>' : ''}</div>`);
        dialog.querySelectorAll('[data-review]').forEach((button) => { button.onclick = () => { dialog.close(); void act(button.dataset.review, id); }; });
        dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal(); return;
      }
      if (kind === 'order') { document.querySelector('[data-page="orders"]')?.click(); $('order-search').value = id; $('order-search').dispatchEvent(new Event('input')); return; }
      if (kind === 'invoiceDetails') {
        if (profile?.role !== 'admin') throw new Error('Only Admin may update invoice details.');
        const invoice = invoices.find((row) => row.id === id);
        if (!invoice || invoiceStatus(invoice) === 'cancelled') throw new Error('An active invoice is required.');
        openDialog('invoiceDetails', id); return;
      }
      if (kind === 'receipt') {
        const row = payments.find((payment) => payment.id === id);
        if (!row?.attachment) throw new Error('No receipt is attached.');
        const result = await callOperation(functions, 'readPaymentReceipt', { paymentId: id });
        const binary = atob(result.base64), bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
        const dialog = document.createElement('dialog'); dialog.className = 'app-dialog receipt-dialog';
        const title = document.createElement('h2'); title.textContent = 'Payment receipt'; dialog.append(title);
        const details = document.createElement('p'); details.textContent = `${row.invoiceNumber} · ${customerName(row)} · ${cash(row.amountPaise)} · ${row.transactionNumber} · ${row.attachment.name}`; dialog.append(details);
        const status = document.createElement('p'); status.textContent = `Status: ${row.verificationStatus} · Reviewed by ${paymentName(row, 'verifiedBy') || '—'} · ${date(row.verifiedAt) || '—'}${row.reviewReason ? ` · Reason: ${row.reviewReason}` : ''}`; dialog.append(status);
        const preview = document.createElement(result.contentType === 'application/pdf' ? 'iframe' : 'img'); preview.src = url; preview.title = 'Receipt preview'; preview.alt = 'Receipt preview'; dialog.append(preview);
        const link = document.createElement('a'); link.className = 'button button-primary'; link.href = url; link.download = result.name || 'receipt'; link.textContent = 'Download'; dialog.append(link);
        if (canVerify() && row.verificationStatus === 'unverified') for (const [decision, label] of [['verify', 'Approve'], ['reject', 'Reject']]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = decision === 'verify' ? 'button button-approve' : 'button button-reject'; button.textContent = label;
          button.onclick = () => { dialog.close(); void act(decision, id); }; dialog.append(button);
        }
        const close = document.createElement('button'); close.type = 'button'; close.className = 'button button-outline'; close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(close);
        dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); }; document.body.append(dialog); dialog.showModal(); return;
      }
      if (kind === 'pdf' || kind === 'preview' || kind === 'share') {
        const invoice = await getFreshInvoice(db, id);
        if (!privileged() && invoice.ownerUid !== user.uid) throw new Error('Invoice access denied.');
        const [business, ownerPayments] = await Promise.all([readBusinessDetails(db), listPayments(db, invoice.ownerUid)]);
        const invoicePayments = ownerPayments.filter((payment) => payment.invoiceId === id);
        if (kind === 'pdf') await downloadInvoicePdf(invoice, business, invoicePayments);
        else {
          const current = ++previewRevision;
          previewInvoice = invoice; previewBlob = null;
          $('invoice-print-sheet').innerHTML = invoicePreviewHtml(invoice, business, invoicePayments);
          $('invoice-preview-share').disabled = true;
          $('invoice-preview-share').textContent = 'Preparing PDF…';
          $('invoice-share-message').textContent = '';
          $('invoice-preview-dialog').showModal();
          createInvoicePdfBlob(invoice, business, invoicePayments).then((blob) => {
            if (current !== previewRevision) return;
            previewBlob = blob;
            $('invoice-preview-share').disabled = false;
            $('invoice-preview-share').textContent = 'Share on WhatsApp';
            if (kind === 'share') $('invoice-share-message').textContent = 'PDF ready. Select Share on WhatsApp to choose WhatsApp or open the customer chat.';
          }).catch(() => { if (current === previewRevision) $('invoice-share-message').textContent = 'PDF could not be prepared. You can still print this invoice.'; });
        }
        return;
      }
      if (['submit', 'correct', 'reject', 'reverse'].includes(kind)) { openDialog(kind, id); return; }
      if (!['paid', 'verify'].includes(kind)) return;
      const key = `${kind}:${id}`;
      if (pendingFinance.has(key)) return;
      if (kind === 'verify' && globalThis.confirm && !globalThis.confirm('Approve this payment and apply it to the invoice balance?')) return;
      pendingFinance.add(key);
      const reviewToken = kind === 'verify' ? globalThis.omsLoading?.start('Approving payment…') : null;
      try {
        if (kind === 'paid') await callOperation(functions, 'markInvoicePaid', { invoiceId: id });
        else await callOperation(functions, 'reviewPayment', { paymentId: id, decision: 'verified' });
        showToast(kind === 'paid' ? 'Invoice marked paid.' : 'Payment verified.');
        await refresh(); await loadPaymentActivity();
      } finally { globalThis.omsLoading?.stop(reviewToken); pendingFinance.delete(key); }
    } catch (error) { showToast(message(error), 'toast-error'); }
  }
  const invoiceToolbar = $('invoice-search').parentElement;
  if (invoiceToolbar?.insertAdjacentHTML) {
    $('invoice-status').insertAdjacentHTML('afterend', '<label class="invoice-filter-field">Assigned User<select id="invoice-user"><option value="">All Users</option></select></label><label class="invoice-filter-field">Customer<select id="invoice-customer"><option value="">All Customers</option></select></label>');
    invoiceToolbar.insertAdjacentHTML('beforeend', '<button id="invoice-refresh" type="button" class="button button-outline">Refresh</button>');
    $('invoice-refresh').onclick = refresh;
  }
  ['invoice', 'payment'].forEach((kind) => {
    if (kind === 'invoice') ['search', 'status', 'user', 'customer', 'from', 'to'].forEach((field) => $(`${kind}-${field}`).addEventListener('input', renderInvoices));
    else $('payment-search').addEventListener('input', () => { appliedPaymentFilters.search = $('payment-search').value.trim(); paymentPage = 1; renderPayments(); });
    $(`${kind}-body`).addEventListener('click', (event) => { const button = event.target.closest('[data-finance]'); if (button) act(button.dataset.finance, button.dataset.id); });
    $(`${kind}-mobile-list`).addEventListener('click', (event) => { const button = event.target.closest('[data-finance]'); if (button) act(button.dataset.finance, button.dataset.id); });
    $(`${kind}-export`).addEventListener('click', () => exportRows(kind === 'invoice' ? 'Invoices' : 'Payments', matching(kind).map((row) => kind === 'invoice' ? { Invoice: row.invoiceNumber, Order: row.orderNumber, Customer: row.customerSnapshot?.fullName, Date: date(row.issuedAt), Total: row.totalPaise / 100, Verified: row.verifiedPaidPaise / 100, Balance: (row.totalPaise - row.verifiedPaidPaise) / 100, Status: statusLabel(invoiceStatus(row)) } : { Submitted: date(row.submittedAt), Customer: customerName(row), Contact: row.customerSnapshot?.contact, Order: row.orderNumber, Invoice: row.invoiceNumber, Collection: row.collectionNumber || '', Amount: row.amountPaise / 100, Mode: row.mode, Reference: row.transactionNumber, SubmittedBy: paymentName(row, 'submittedBy'), Status: row.reversalId ? 'reversed' : row.verificationStatus, Verifier: paymentName(row, 'verifiedBy'), VerifiedAt: date(row.verifiedAt), Attachment: row.attachment?.path || '', AttachmentName: row.attachment?.name || '', RejectionReason: row.reviewReason || '' })));
  });
  $('payment-body').closest?.('table')?.querySelector('thead tr th:last-child')?.insertAdjacentHTML('beforebegin', '<th>Verified at</th>');
  $('payment-apply').onclick = () => { appliedPaymentFilters = readPaymentFilters(); paymentPage = 1; renderPayments(); };
  $('payment-clear').onclick = () => { paymentFilterIds.forEach((field) => { $(`payment-${field}`).value = ''; }); appliedPaymentFilters = {}; paymentPage = 1; renderPayments(); };
  $('payment-refresh').onclick = refresh;
  const paymentPanel = $('payment-body').closest?.('.ops-panel');
  if (paymentPanel?.insertAdjacentHTML) {
    paymentPanel.insertAdjacentHTML('beforeend', '<div class="master-pagination"><button id="payment-prev" type="button" class="button button-outline">Previous</button><span id="payment-page">Page 1</span><button id="payment-next" type="button" class="button button-outline">Next</button></div>');
    $('payment-prev').onclick = () => { if (paymentPage > 1) { paymentPage--; renderPayments(); } };
    $('payment-next').onclick = () => { paymentPage++; renderPayments(); };
  }
  const paymentView = $('payments-view');
  document.addEventListener('oms:create-single-payment', () => {
    const available = invoices.filter((row) => row.customerId && row.totalPaise > row.verifiedPaidPaise && !['paid', 'in_process', 'cancelled', 'overpaid'].includes(invoiceStatus(row)) && (canVerify() || row.ownerUid === user?.uid));
    const dialog = document.createElement('dialog'); dialog.className = 'app-dialog payment-picker-dialog';
    dialog.innerHTML = `<div class="dialog-header"><h2>Create Payment</h2><button type="button" data-close class="icon-button" aria-label="Close">×</button></div><div class="payment-picker-body"><label class="ops-field">User<select id="single-payment-user"><option value="">Choose a user</option></select></label><label class="ops-field">Customer<select id="single-payment-customer" disabled><option value="">Choose a customer</option></select></label><label class="ops-field" for="single-payment-search">Search invoice<input id="single-payment-search" type="search" placeholder="Search invoice number or customer" autocomplete="off"></label><label class="ops-field" for="single-payment-invoice">Available invoices<select id="single-payment-invoice" disabled><option value="">Choose an invoice</option></select></label><div id="single-payment-summary" aria-live="polite"></div>${available.length ? '' : '<p class="payment-form-note">No payable invoices are available.</p>'}</div><div class="dialog-actions"><button type="button" data-continue class="button button-primary" disabled>Continue</button></div>`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    const select = dialog.querySelector('#single-payment-invoice'), userSelect = dialog.querySelector('#single-payment-user'), customerSelect = dialog.querySelector('#single-payment-customer');
    const owners = [...new Set(available.map((row) => row.ownerUid).filter(Boolean))];
    const ownerName = (id) => { const entry = paymentUsers.find((row) => row.id === id); return entry?.displayName || entry?.fullName || entry?.name || entry?.email || id; };
    owners.sort((a, b) => new Intl.Collator('en', { sensitivity: 'base' }).compare(ownerName(a), ownerName(b)));
    userSelect.innerHTML += owners.map((id) => `<option value="${esc(id)}">${esc(ownerName(id))}</option>`).join('');
    const updateInvoices = () => {
      const term = dialog.querySelector('#single-payment-search').value.trim().toLowerCase();
      const choices = available.filter((row) => row.ownerUid === userSelect.value && row.customerId === customerSelect.value && `${row.invoiceNumber} ${row.customerSnapshot?.fullName || ''}`.toLowerCase().includes(term));
      select.innerHTML = `<option value="">Choose an invoice</option>${choices.map((row) => `<option value="${esc(row.id)}">${esc(row.invoiceNumber)} · ${esc(row.customerSnapshot?.fullName)} · ${esc(cash(row.totalPaise - row.verifiedPaidPaise))} due</option>`).join('')}`;
      select.disabled = !customerSelect.value;
      select.onchange();
    };
    userSelect.onchange = () => {
      const customers = [...new Map(available.filter((row) => row.ownerUid === userSelect.value).map((row) => [row.customerId, row.customerSnapshot?.fullName || row.customerId])).entries()].sort((a, b) => new Intl.Collator('en', { sensitivity: 'base' }).compare(a[1], b[1]));
      customerSelect.innerHTML = `<option value="">Choose a customer</option>${customers.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}`;
      customerSelect.disabled = !userSelect.value;
      updateInvoices();
    };
    customerSelect.onchange = updateInvoices;
    dialog.querySelector('#single-payment-search').oninput = updateInvoices;
    select.onchange = () => { const invoice = available.find((row) => row.id === select.value && row.ownerUid === userSelect.value && row.customerId === customerSelect.value); dialog.querySelector('#single-payment-summary').innerHTML = paymentInvoiceSummary(invoice); dialog.querySelector('[data-continue]').disabled = !invoice; };
    dialog.querySelector('[data-continue]').onclick = () => { const id = select.value; if (!available.some((row) => row.id === id && row.ownerUid === userSelect.value && row.customerId === customerSelect.value)) return; dialog.close(); openDialog('submit', id); };
    dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  });
  document.addEventListener('oms:single-payment-action', (event) => act(event.detail.kind, event.detail.id));
  let activityPage = 1, activityCursors = [null], activityRevision = 0, activityRows = [], activityHasMore = false;
  const activityMounted = Boolean(paymentView?.insertAdjacentHTML);
  const activityFilters = () => Object.fromEntries(['actor', 'customer', 'order', 'invoice', 'type', 'from', 'to'].map((field) => [field, $(`payment-activity-${field}`).value.trim()]));
  function renderPaymentActivity() {
    if (!activityMounted) return;
    $('payment-activity-body').innerHTML = activityRows.length ? activityRows.map((row) => { const ref = references(row); return `<tr><td>${esc(activityDate(row.at))}</td><td>${esc(actionLabel(row.type))}</td><td>${esc(ref.customer)}</td><td>${esc(ref.order)}</td><td>${esc(ref.invoice)}</td><td>${esc(ref.amount == null ? 'Not available' : `₹${(Number(ref.amount) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</td><td>${esc(ref.mode ? ({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer' }[ref.mode] || ref.mode) : 'Not available')}</td><td>${esc(ref.actor)}</td><td>${esc(changeSummary(row))}</td></tr>`; }).join('') : '<tr><td colspan="9" class="empty-cell">No payment activity matches these filters.</td></tr>';
    $('payment-activity-cards').innerHTML = activityRows.length ? activityRows.map((row) => {
      const ref = references(row);
      const amount = ref.amount == null ? 'Not available' : `₹${(Number(ref.amount) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const field = (label, value, extra = '') => `<div class="payment-activity-card-field ${extra}"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
      const outcome = row.outcome ? `<span class="payment-activity-outcome">${esc(row.outcome)}</span>` : '';
      return `<article class="payment-activity-card"><header><div><h4>${esc(actionLabel(row.type))}</h4><time>${esc(activityDate(row.at))}</time></div>${outcome}</header><dl>${field('Actor', ref.actor)}${field('Customer', ref.customer)}${field('Order', ref.order, 'payment-activity-reference')}${field('Invoice', ref.invoice, 'payment-activity-reference')}</dl><div class="payment-activity-card-amount"><span>Amount</span><strong>${esc(amount)}</strong></div>${ref.mode ? `<p class="payment-activity-card-note">Method: ${esc(({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer' })[ref.mode] || ref.mode)}</p>` : ''}<p class="payment-activity-card-note">${esc(changeSummary(row))}</p></article>`;
    }).join('') : '<p class="payment-activity-cards-empty">No payment activity matches these filters.</p>';
    $('payment-activity-page').textContent = `Page ${activityPage}`;
    $('payment-activity-prev').disabled = activityPage === 1;
    $('payment-activity-next').disabled = !activityHasMore;
  }
  async function loadPaymentActivity() {
    if (!activityMounted || !user || !profile) return;
    const current = ++activityRevision;
    $('payment-activity-message').textContent = '';
    stopActivityLoad();
    const token = globalThis.omsLoading?.start('Loading payment activity…') || null;
    activityLoadToken = token;
    try {
      const result = await listActivity(db, profile, user?.uid, 'payment', activityFilters(), activityCursors[activityPage - 1]);
      if (current !== activityRevision) return;
      activityRows = result.rows || []; activityHasMore = Boolean(result.hasMore);
      activityCursors[activityPage] = result.cursor;
      $('payment-activity-message').textContent = '';
      renderPaymentActivity();
    } catch (error) { if (current === activityRevision) $('payment-activity-message').textContent = `Could not load payment activity: ${message(error)}`; }
    finally { if (activityLoadToken === token) stopActivityLoad(); }
  }
  if (activityMounted) {
    paymentView.insertAdjacentHTML('beforeend', `<div class="section-heading"><div><p class="eyebrow">HISTORY</p><h3>Payment Activity Log</h3></div></div><div id="payment-activity-panel" class="card ops-panel"><div class="ops-toolbar"><input id="payment-activity-actor" type="search" placeholder="Search actor" aria-label="Search payment activity by actor"><input id="payment-activity-customer" type="search" placeholder="Customer" aria-label="Activity customer"><input id="payment-activity-order" type="search" placeholder="Order" aria-label="Activity order"><input id="payment-activity-invoice" type="search" placeholder="Invoice" aria-label="Activity invoice"><select id="payment-activity-type" aria-label="Activity action"><option value="">All actions</option><option value="payment.submitted">Submitted</option><option value="payment.mode_changed">Mode changed</option><option value="payment.verified">Verified</option><option value="payment.rejected">Rejected</option><option value="payment.reversed">Reversed</option></select><input id="payment-activity-from" type="date" aria-label="Activity from"><input id="payment-activity-to" type="date" aria-label="Activity to"><button id="payment-activity-apply" type="button" class="button button-outline">Apply</button><button id="payment-activity-export" type="button" class="button button-outline">Export XLSX</button></div><p id="payment-activity-message" class="ops-message" role="status"></p><div class="table-scroll payment-activity-table-scroll"><table class="payment-activity-table"><thead><tr><th>When</th><th>Action</th><th>Customer</th><th>Order</th><th>Invoice</th><th>Amount</th><th>Method</th><th>Actor</th><th>Changes / reason</th></tr></thead><tbody id="payment-activity-body"></tbody></table></div><div id="payment-activity-cards" class="payment-activity-cards" aria-label="Payment activity entries"></div><div class="master-pagination"><button id="payment-activity-prev" type="button" class="button button-outline">Previous</button><span id="payment-activity-page">Page 1</span><button id="payment-activity-next" type="button" class="button button-outline">Next</button></div></div>`);
    $('payment-activity-apply').onclick = () => { activityPage = 1; activityCursors = [null]; loadPaymentActivity(); };
    $('payment-activity-prev').onclick = () => { if (activityPage > 1) { activityPage--; loadPaymentActivity(); } };
    $('payment-activity-next').onclick = () => { if (activityHasMore) { activityPage++; loadPaymentActivity(); } };
    $('payment-activity-export').onclick = async () => {
      try {
        const rows = [], seen = new Set(); let cursor = null;
        do {
          const result = await listActivity(db, profile, user?.uid, 'payment', activityFilters(), cursor);
          for (const row of result.rows || []) if (!seen.has(row.id)) { const ref = references(row); seen.add(row.id); rows.push({ When: activityDate(row.at), Action: actionLabel(row.type), Customer: ref.customer, Order: ref.order, Invoice: ref.invoice, Actor: ref.actor, Changes: changeSummary(row), Outcome: row.outcome || 'Success' }); }
          if (!result.hasMore || !result.cursor || result.cursor === cursor) break;
          cursor = result.cursor;
        } while (true);
        await exportRows('Payment activity', rows);
      } catch (error) { showToast(message(error), 'toast-error'); }
    };
  }
  $('finance-dialog-close').onclick = $('finance-cancel').onclick = () => $('finance-dialog').close();
  $('invoice-preview-close').onclick = () => $('invoice-preview-dialog').close();
  $('invoice-preview-print').onclick = () => window.print();
  $('invoice-preview-share').onclick = async () => {
    if (!previewInvoice || !previewBlob) return;
    try {
      const result = await shareInvoicePdf(previewInvoice, previewBlob, { download: downloadBlob });
      $('invoice-share-message').textContent = ({ shared: 'Share sheet closed. Confirm the recipient in WhatsApp.', cancelled: 'Sharing cancelled. The invoice is still available.', manual: 'PDF downloaded. No verified international customer number is stored; select the contact and attach the PDF manually.', whatsapp: 'PDF downloaded. Attach it manually in the opened WhatsApp chat before sending.', 'popup-blocked': 'PDF downloaded. Allow the WhatsApp popup or open the chat yourself and attach the PDF manually.' })[result];
    } catch (error) { $('invoice-share-message').textContent = message(error); }
  };
  $('finance-form').addEventListener('invalid', (event) => {
    $('finance-error').textContent = event.target.name === 'amount'
      ? 'Enter an amount greater than zero, with at most two decimal places and no more than the outstanding balance.'
      : 'Complete the required field before saving.';
    $('finance-error').hidden = false;
  }, true);
  $('finance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('finance-save').disabled) return;
    $('finance-save').disabled = true; $('finance-save').textContent = 'Saving…'; $('finance-error').hidden = true;
    try {
      const fields = new FormData(event.currentTarget);
      if (action === 'invoiceDetails') {
        const invoice = invoices.find((row) => row.id === target);
        const details = Object.fromEntries(['fullName', 'contact', 'area', 'address'].map((key) => [key, String(fields.get(key) || '').trim()]));
        if (!invoice || !details.fullName || !details.contact) throw new Error('Customer name and contact number are required.');
        await callOperation(functions, 'updateInvoiceDetails', { invoiceId: target, ...details });
      } else if (action === 'submit') {
        const amount = Number(fields.get('amount')); if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('Enter a positive amount with at most two decimal places.');
        const invoice = invoices.find((row) => row.id === target);
        if (!invoice || Math.round(amount * 100) > invoice.totalPaise - invoice.verifiedPaidPaise) throw new Error('Payment exceeds the current outstanding balance. Refresh the invoice and try again.');
        if (fields.get('mode') !== 'cash' && !String(fields.get('reference') || '').trim()) throw new Error('UPI and bank transfers require a transaction reference.');
        if (fields.get('mode') !== 'cash' && !receiptFile) throw new Error('Payment proof is required for UPI and bank transfers.');
        let attachment = null;
        if (receiptFile && !uploadedReceipt) {
          const extension = validReceipt(receiptFile);
          const path = `paymentReceipts/${user.uid}/${paymentOperationId}.${extension}`;
          const token = globalThis.omsLoading?.start('Uploading payment proof…');
          try {
            receiptUpload = uploadBytesResumable(storageRef(getStorage(db.app), path), receiptFile, { contentType: receiptFile.type, customMetadata: { ownerUid: user.uid, invoiceId: target, originalName: receiptFile.name.slice(0, 150) } });
            await new Promise((resolve, reject) => receiptUpload.on('state_changed', (snap) => { $('payment-proof-info').textContent = `${receiptFile.name} · ${(receiptFile.size / 1024 / 1024).toFixed(2)} MB · ${Math.round(snap.bytesTransferred / snap.totalBytes * 100)}%`; }, reject, resolve));
            uploadedReceipt = { extension };
          } finally { globalThis.omsLoading?.stop(token); receiptUpload = null; }
        }
        attachment = uploadedReceipt;
        await callOperation(functions, 'submitPayment', { invoiceId: target, amountPaise: Math.round(amount * 100), mode: fields.get('mode'), transactionNumber: fields.get('mode') === 'cash' ? '-' : fields.get('reference'), operationId: paymentOperationId, attachment, remarks: String(fields.get('remarks') || '').trim() });
        invoice.paymentStatus = 'in_process';
        renderInvoices();
      } else if (action === 'correct') {
        if (fields.get('mode') !== 'cash' && !String(fields.get('reference') || '').trim()) throw new Error('UPI and bank transfers require a transaction reference.');
        await callOperation(functions, 'changePaymentMode', { paymentId: target, mode: fields.get('mode'), transactionNumber: fields.get('mode') === 'cash' ? '-' : fields.get('reference'), reason: fields.get('reason') });
      }
      else {
        const reason = String(fields.get('reason') || '').trim();
        if (!reason) throw new Error('A reason is required.');
        if (action === 'reject' && globalThis.confirm && !globalThis.confirm('Reject this payment? It will not count toward the invoice balance.')) return;
        await callOperation(functions, action === 'reject' ? 'reviewPayment' : 'reversePayment', action === 'reject' ? { paymentId: target, decision: 'rejected', reason } : { paymentId: target, reason });
      }
      paymentOperationId = '';
      clearReceipt();
      $('finance-dialog').close(); showToast(action === 'submit' ? 'Payment submitted for verification.' : action === 'invoiceDetails' ? 'Invoice details updated.' : 'Payment history updated.'); await refresh(); if (action !== 'invoiceDetails') await loadPaymentActivity();
    } catch (error) { $('finance-error').textContent = message(error); $('finance-error').hidden = false; } finally { $('finance-save').disabled = false; $('finance-save').textContent = action === 'submit' ? 'Submit for Verification' : 'Save'; }
  });
  document.addEventListener('oms:pagechange', (event) => { if (!['invoices', 'payments'].includes(event.detail.page)) stopRecordLoad(); if (event.detail.page !== 'payments') stopActivityLoad(); if (['invoices', 'payments'].includes(event.detail.page)) refresh(); if (event.detail.page === 'payments') loadPaymentActivity(); });
  return { setSession(nextUser, nextProfile) { revision++; activityRevision++; stopRecordLoad(); stopActivityLoad(); user = nextUser; profile = nextProfile; invoices = []; payments = []; paymentUsers = []; invoiceCustomers = []; orderAssignees = new Map(); paymentsLoaded = false; resolvedNames = new Map(); paymentPage = 1; activityRows = []; activityPage = 1; activityCursors = [null]; $('invoice-user').value = ''; $('invoice-customer').value = ''; if (user && profile) refresh(); else { $('invoice-body').innerHTML = ''; $('payment-body').innerHTML = ''; renderPaymentActivity(); } } };
}
