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
  let user = null, profile = null, invoices = [], payments = [], paymentsLoaded = false, revision = 0, action = '', target = '', resolvedNames = new Map(), paymentOperationId = '', paymentPage = 1;
  let previewInvoice = null, previewBlob = null, previewRevision = 0;
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
  const invoiceStatus = (row) => row.paymentStatus === 'paid' || row.paymentStatus === 'ready_to_mark_paid' && row.verifiedPaidPaise === row.totalPaise ? 'paid'
    : payments.some((payment) => payment.invoiceId === row.id && payment.verificationStatus === 'unverified') ? 'in_process' : row.paymentStatus;
  const statusLabel = (status) => ({ unpaid: 'Unpaid', partial: 'Partial', in_process: 'In process', ready_to_mark_paid: 'Ready to mark paid', paid: 'Paid' })[status] || status || 'Unknown';
  const statusBadge = (status) => `<span class="status-badge is-${esc(String(status || 'unknown').replace(/_/g, '-'))}">${esc(statusLabel(status))}</span>`;
  const matching = (kind) => {
    const rows = kind === 'invoice' ? invoices : payments;
    const search = $(`${kind}-search`).value.trim().toLowerCase(), status = $(`${kind}-status`).value, from = $(`${kind}-from`).value, to = $(`${kind}-to`).value;
    const extra = kind === 'payment' ? Object.fromEntries(['customer', 'order', 'invoice', 'mode', 'submitter', 'verifier'].map((field) => [field, $( `payment-${field}` ).value.trim().toLowerCase()])) : {};
    return rows.filter((row) => {
      const haystack = `${row.invoiceNumber} ${row.orderNumber} ${row.customerSnapshot?.fullName} ${row.customerSnapshot?.contact} ${row.transactionNumber || ''} ${kind === 'payment' ? `${customerName(row)} ${paymentName(row, 'submittedBy')} ${paymentName(row, 'verifiedBy')}` : ''}`.toLowerCase();
      const day = iso(kind === 'invoice' ? row.issuedAt : row.submittedAt);
      return (!search || haystack.includes(search)) && (!status || (kind === 'invoice' ? invoiceStatus(row) : row.reversalId ? 'reversed' : row.verificationStatus) === status) && (!from || day >= from) && (!to || day <= to)
        && (kind !== 'payment' || (!extra.customer || `${customerName(row)} ${row.customerSnapshot?.contact || ''}`.toLowerCase().includes(extra.customer))
          && (!extra.order || String(row.orderNumber || '').toLowerCase().includes(extra.order))
          && (!extra.invoice || String(row.invoiceNumber || '').toLowerCase().includes(extra.invoice))
          && (!extra.mode || row.mode === extra.mode)
          && (!extra.submitter || paymentName(row, 'submittedBy').toLowerCase().includes(extra.submitter))
          && (!extra.verifier || paymentName(row, 'verifiedBy').toLowerCase().includes(extra.verifier)));
    }).sort((a, b) => (kind === 'invoice' ? b.issuedAt?.seconds - a.issuedAt?.seconds : b.submittedAt?.seconds - a.submittedAt?.seconds) || 0);
  };
  function renderInvoices() {
    const rows = matching('invoice');
    $('invoice-cards').innerHTML = stat('Visible invoices', rows.length) + stat('Outstanding', cash(rows.reduce((sum, row) => sum + row.totalPaise - row.verifiedPaidPaise, 0))) + stat('Verified payments', cash(rows.reduce((sum, row) => sum + row.verifiedPaidPaise, 0)));
    $('invoice-body').innerHTML = rows.length ? rows.map((row) => {
      const status = invoiceStatus(row);
      return `<tr><td>${esc(row.invoiceNumber || `INV-${row.orderNumber}`)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.customerSnapshot?.fullName)}</td><td>${esc(date(row.issuedAt))}</td><td>${esc(cash(row.totalPaise))}</td><td>${esc(cash(row.verifiedPaidPaise))}</td><td>${esc(cash(row.totalPaise - row.verifiedPaidPaise))}</td><td>${statusBadge(status)}</td><td class="ops-actions"><button type="button" data-finance="preview" data-id="${esc(row.id)}">Preview / Print</button><button type="button" data-finance="pdf" data-id="${esc(row.id)}">PDF</button><button type="button" data-finance="share" data-id="${esc(row.id)}">Share on WhatsApp</button>${paymentsLoaded && status !== 'paid' && status !== 'in_process' && row.totalPaise > row.verifiedPaidPaise && (canVerify() || row.ownerUid === user?.uid) ? `<button type="button" data-finance="submit" data-id="${esc(row.id)}">Add payment</button>` : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="9" class="empty-cell">No invoices match your access or filters.</td></tr>';
    if (!rows.length && !invoices.length) $('invoice-body').innerHTML = '<tr><td colspan="9" class="empty-cell">No invoice has been created yet. An Admin or Account Admin must choose Create invoice on a confirmed order.</td></tr>';
    $('invoice-mobile-list').innerHTML = rows.length ? rows.map((row) => {
      const status = invoiceStatus(row);
      return `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(row.invoiceNumber || `INV-${row.orderNumber}`)}</strong>${statusBadge(status)}</div><p>${esc(row.customerSnapshot?.fullName)}<small>${esc(date(row.issuedAt))} · ${esc(row.orderNumber)}</small></p><div class="mobile-record-bottom"><b>${esc(cash(row.totalPaise))}</b><div class="mobile-record-actions"><button type="button" data-finance="preview" data-id="${esc(row.id)}">View</button><button type="button" data-finance="pdf" data-id="${esc(row.id)}">PDF</button><button type="button" data-finance="share" data-id="${esc(row.id)}">Share</button></div></div></article>`;
    }).join('') : '<p class="mobile-record-empty">No invoices match the current filters.</p>';
  }
  function renderPayments() {
    const rows = matching('payment');
    const pageCount = Math.max(1, Math.ceil(rows.length / 25));
    paymentPage = Math.min(paymentPage, pageCount);
    const visibleRows = rows.slice((paymentPage - 1) * 25, paymentPage * 25);
    const collected = rows.filter((row) => row.verificationStatus === 'verified' && !row.reversalId);
    $('payment-cards').innerHTML = stat('Submissions', rows.length) + stat('Awaiting review', rows.filter((row) => row.verificationStatus === 'unverified').length) + stat('Online collection (verified)', cash(collected.filter((row) => row.mode === 'upi' || row.mode === 'bank_transfer').reduce((sum, row) => sum + row.amountPaise, 0))) + stat('Cash collection (verified)', cash(collected.filter((row) => row.mode === 'cash').reduce((sum, row) => sum + row.amountPaise, 0)));
    $('payment-body').innerHTML = visibleRows.length ? visibleRows.map((row) => `<tr><td>${esc(date(row.submittedAt))}</td><td>${esc(customerName(row))}</td><td>${esc(row.customerSnapshot?.contact)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.invoiceNumber)}</td><td>${esc(cash(row.amountPaise))}</td><td>${esc(row.mode)}</td><td>${esc(row.transactionNumber)}</td><td>${esc(paymentName(row, 'submittedBy'))}</td><td>${esc(row.reversalId ? 'reversed' : row.verificationStatus)}</td><td>${esc(paymentName(row, 'verifiedBy'))}${row.receivedBy ? `<small>Received: ${esc(paymentName(row, 'receivedBy'))}</small>` : ''}</td><td class="ops-actions">${canVerify() && row.verificationStatus === 'unverified' ? `<button type="button" data-finance="verify" data-id="${esc(row.id)}">Verify</button><button type="button" data-finance="reject" data-id="${esc(row.id)}">Reject</button>` : ''}${canVerify() && row.verificationStatus === 'verified' && !row.reversalId ? `<button type="button" data-finance="reverse" data-id="${esc(row.id)}">Reverse</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="13" class="empty-cell">No payments match your access or filters.</td></tr>';
    if (!rows.length && !payments.length) $('payment-body').innerHTML = '<tr><td colspan="13" class="empty-cell">No payment has been submitted yet. Open an invoice and select Add payment.</td></tr>';
    $('payment-body').querySelectorAll?.('tr').forEach((tr, index) => {
      if (!visibleRows[index]) { tr.querySelector('td')?.setAttribute('colspan', '13'); return; }
      tr.querySelector('td:last-child')?.insertAdjacentHTML('beforebegin', `<td>${esc(date(visibleRows[index].verifiedAt))}</td>`);
    });
    if (canVerify()) $('payment-body').querySelectorAll?.('[data-finance="verify"]').forEach((button) => button.insertAdjacentHTML('beforebegin', `<button type="button" data-finance="correct" data-id="${esc(button.dataset.id)}">Correct mode</button>`));
    $('payment-mobile-list').innerHTML = visibleRows.length ? visibleRows.map((row) => `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(row.transactionNumber || row.invoiceNumber || 'Payment')}</strong><span class="mobile-status">${esc(row.reversalId ? 'reversed' : row.verificationStatus)}</span></div><p>${esc(customerName(row))}<small>${esc(date(row.submittedAt))} · ${esc(row.mode)}</small></p><div class="mobile-record-bottom"><b>${esc(cash(row.amountPaise))}</b><div class="mobile-record-actions">${canVerify() && row.verificationStatus === 'unverified' ? `<button type="button" data-finance="verify" data-id="${esc(row.id)}">Verify</button><button type="button" data-finance="reject" data-id="${esc(row.id)}">Reject</button>` : ''}${canVerify() && row.verificationStatus === 'verified' && !row.reversalId ? `<button type="button" data-finance="reverse" data-id="${esc(row.id)}">Reverse</button>` : ''}</div></div></article>`).join('') : '<p class="mobile-record-empty">No payments match the current filters.</p>';
    if ($('payment-page')) { $('payment-page').textContent = `Page ${paymentPage} of ${pageCount}`; $('payment-prev').disabled = paymentPage === 1; $('payment-next').disabled = paymentPage >= pageCount; }
  }
  async function refresh() {
    if (!user || !profile) return;
    const current = ++revision, owner = privileged() ? null : user.uid;
    $('invoice-message').textContent = 'Loading invoices…'; $('payment-message').textContent = 'Loading payments…';
    const [invoiceResult, paymentResult] = await Promise.allSettled([listInvoices(db, owner), listPayments(db, owner)]);
    if (current !== revision) return;
    invoices = invoiceResult.status === 'fulfilled' ? invoiceResult.value : [];
    payments = paymentResult.status === 'fulfilled' ? paymentResult.value : [];
    paymentsLoaded = paymentResult.status === 'fulfilled';
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
    $('invoice-message').textContent = invoiceResult.status === 'rejected' ? `Could not load invoices: ${message(invoiceResult.reason)}`
      : paymentResult.status === 'rejected' ? 'Could not check payment submissions. Refresh before adding a payment.' : '';
    $('payment-message').textContent = paymentResult.status === 'rejected' ? `Could not load payments: ${message(paymentResult.reason)}` : '';
  }
  function openDialog(kind, id) {
    action = kind; target = id; $('finance-error').hidden = true;
    const invoice = invoices.find((row) => row.id === id);
    if (kind === 'submit') paymentOperationId = uniqueId();
    const payment = payments.find((row) => row.id === id);
    const outstanding = invoice ? (invoice.totalPaise - invoice.verifiedPaidPaise) / 100 : 0;
    $('finance-dialog-title').textContent = ({ submit: 'Submit payment', correct: 'Correct payment mode', reject: 'Reject payment', reverse: 'Reverse verified payment' })[kind];
    $('finance-fields').innerHTML = kind === 'submit' ? `<p>Outstanding: <strong>${esc(cash(invoice.totalPaise - invoice.verifiedPaidPaise))}</strong>. Submissions count only after staff verification.</p><label class="ops-field">Amount (₹)<input name="amount" type="number" min="0.01" step="0.01" max="${outstanding.toFixed(2)}" value="${outstanding.toFixed(2)}" required></label><label class="ops-field">Mode<select name="mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ops-field">Transaction reference<input name="reference" maxlength="100" placeholder="Cash uses -"></label>` : kind === 'correct' ? `<p>Current mode: ${esc(payment?.mode)} · Reference: ${esc(payment?.transactionNumber)}</p><label class="ops-field">New mode<select name="mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ops-field">New transaction reference<input name="reference" maxlength="100" placeholder="Cash uses -"></label><label class="ops-field">Reason<textarea name="reason" maxlength="500" required></textarea></label>` : '<label class="ops-field">Reason<textarea name="reason" maxlength="500" required></textarea></label>';
    $('finance-dialog').showModal();
  }
  async function act(kind, id) {
    try {
      if (['verify', 'reject', 'reverse', 'correct'].includes(kind) && !canVerify()) throw new Error('Access denied: payment review requires a privileged OMS role.');
      if (kind === 'order') { document.querySelector('[data-page="orders"]')?.click(); $('order-search').value = id; $('order-search').dispatchEvent(new Event('input')); return; }
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
      if (kind === 'paid') await callOperation(functions, 'markInvoicePaid', { invoiceId: id });
      if (kind === 'verify') await callOperation(functions, 'reviewPayment', { paymentId: id, decision: 'verified' });
      showToast(kind === 'paid' ? 'Invoice marked paid.' : 'Payment verified.'); await refresh(); await loadPaymentActivity();
    } catch (error) { showToast(message(error), 'toast-error'); }
  }
  ['invoice', 'payment'].forEach((kind) => {
    ['search', 'status', 'from', 'to'].forEach((field) => $(`${kind}-${field}`).addEventListener('input', () => { if (kind === 'invoice') renderInvoices(); else { paymentPage = 1; renderPayments(); } }));
    $(`${kind}-body`).addEventListener('click', (event) => { const button = event.target.closest('[data-finance]'); if (button) act(button.dataset.finance, button.dataset.id); });
    $(`${kind}-mobile-list`).addEventListener('click', (event) => { const button = event.target.closest('[data-finance]'); if (button) act(button.dataset.finance, button.dataset.id); });
    $(`${kind}-export`).addEventListener('click', () => exportRows(kind === 'invoice' ? 'Invoices' : 'Payments', matching(kind).map((row) => kind === 'invoice' ? { Invoice: row.invoiceNumber, Order: row.orderNumber, Customer: row.customerSnapshot?.fullName, Date: date(row.issuedAt), Total: row.totalPaise / 100, Verified: row.verifiedPaidPaise / 100, Balance: (row.totalPaise - row.verifiedPaidPaise) / 100, Status: statusLabel(invoiceStatus(row)) } : { Submitted: date(row.submittedAt), Customer: customerName(row), Contact: row.customerSnapshot?.contact, Order: row.orderNumber, Invoice: row.invoiceNumber, Amount: row.amountPaise / 100, Mode: row.mode, Reference: row.transactionNumber, SubmittedBy: paymentName(row, 'submittedBy'), Status: row.reversalId ? 'reversed' : row.verificationStatus, Verifier: paymentName(row, 'verifiedBy'), VerifiedAt: date(row.verifiedAt) })));
  });
  const paymentToolbar = $('payment-search').parentElement;
  const invoiceToolbar = $('invoice-search').parentElement;
  if (invoiceToolbar?.insertAdjacentHTML) {
    invoiceToolbar.insertAdjacentHTML('beforeend', '<button id="invoice-refresh" type="button" class="button button-outline">Refresh</button>');
    $('invoice-refresh').onclick = refresh;
  }
  $('payment-body').closest?.('table')?.querySelector('thead tr th:last-child')?.insertAdjacentHTML('beforebegin', '<th>Verified at</th>');
  if (paymentToolbar?.insertAdjacentHTML) {
    paymentToolbar.insertAdjacentHTML('beforeend', '<input id="payment-customer" type="search" placeholder="Customer" aria-label="Customer"><input id="payment-order" type="search" placeholder="Order" aria-label="Order"><input id="payment-invoice" type="search" placeholder="Invoice" aria-label="Invoice"><select id="payment-mode" aria-label="Payment mode"><option value="">All modes</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option></select><input id="payment-submitter" type="search" placeholder="Submitted by" aria-label="Submitted by"><input id="payment-verifier" type="search" placeholder="Verified by" aria-label="Verified by"><button id="payment-refresh" type="button" class="button button-outline">Refresh</button>');
    ['customer', 'order', 'invoice', 'mode', 'submitter', 'verifier'].forEach((field) => $(`payment-${field}`).addEventListener('input', () => { paymentPage = 1; renderPayments(); }));
    $('payment-refresh').onclick = refresh;
  }
  const paymentPanel = $('payment-body').closest?.('.ops-panel');
  if (paymentPanel?.insertAdjacentHTML) {
    paymentPanel.insertAdjacentHTML('beforeend', '<div class="master-pagination"><button id="payment-prev" type="button" class="button button-outline">Previous</button><span id="payment-page">Page 1</span><button id="payment-next" type="button" class="button button-outline">Next</button></div>');
    $('payment-prev').onclick = () => { if (paymentPage > 1) { paymentPage--; renderPayments(); } };
    $('payment-next').onclick = () => { paymentPage++; renderPayments(); };
  }
  const paymentView = $('payments-view');
  let activityPage = 1, activityCursors = [null], activityRevision = 0, activityRows = [], activityHasMore = false;
  const activityMounted = Boolean(paymentView?.insertAdjacentHTML);
  const activityFilters = () => Object.fromEntries(['actor', 'customer', 'order', 'invoice', 'type', 'from', 'to'].map((field) => [field, $(`payment-activity-${field}`).value.trim()]));
  function renderPaymentActivity() {
    if (!activityMounted) return;
    $('payment-activity-body').innerHTML = activityRows.length ? activityRows.map((row) => { const ref = references(row); return `<tr><td>${esc(activityDate(row.at))}</td><td>${esc(actionLabel(row.type))}</td><td>${esc(ref.customer)}</td><td>${esc(ref.order)}</td><td>${esc(ref.invoice)}</td><td>${esc(ref.amount == null ? 'Not available' : `₹${(Number(ref.amount) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</td><td>${esc(ref.mode ? ({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer' }[ref.mode] || ref.mode) : 'Not available')}</td><td>${esc(ref.actor)}</td><td>${esc(changeSummary(row))}</td></tr>`; }).join('') : '<tr><td colspan="9" class="empty-cell">No payment activity matches these filters.</td></tr>';
    $('payment-activity-page').textContent = `Page ${activityPage}`;
    $('payment-activity-prev').disabled = activityPage === 1;
    $('payment-activity-next').disabled = !activityHasMore;
  }
  async function loadPaymentActivity() {
    if (!activityMounted || !user || !profile) return;
    const current = ++activityRevision;
    $('payment-activity-message').textContent = 'Loading payment activity…';
    try {
      const result = await listActivity(db, profile, user?.uid, 'payment', activityFilters(), activityCursors[activityPage - 1]);
      if (current !== activityRevision) return;
      activityRows = result.rows || []; activityHasMore = Boolean(result.hasMore);
      activityCursors[activityPage] = result.cursor;
      $('payment-activity-message').textContent = '';
      renderPaymentActivity();
    } catch (error) { if (current === activityRevision) $('payment-activity-message').textContent = `Could not load payment activity: ${message(error)}`; }
  }
  if (activityMounted) {
    paymentView.insertAdjacentHTML('beforeend', `<div class="section-heading"><div><p class="eyebrow">HISTORY</p><h3>Payment Activity Log</h3></div></div><div class="card ops-panel"><div class="ops-toolbar"><input id="payment-activity-actor" type="search" placeholder="Actor" aria-label="Activity actor"><input id="payment-activity-customer" type="search" placeholder="Customer" aria-label="Activity customer"><input id="payment-activity-order" type="search" placeholder="Order" aria-label="Activity order"><input id="payment-activity-invoice" type="search" placeholder="Invoice" aria-label="Activity invoice"><select id="payment-activity-type" aria-label="Activity action"><option value="">All actions</option><option value="payment.submitted">Submitted</option><option value="payment.mode_changed">Mode changed</option><option value="payment.verified">Verified</option><option value="payment.rejected">Rejected</option><option value="payment.reversed">Reversed</option></select><input id="payment-activity-from" type="date" aria-label="Activity from"><input id="payment-activity-to" type="date" aria-label="Activity to"><button id="payment-activity-apply" type="button" class="button button-outline">Apply</button><button id="payment-activity-export" type="button" class="button button-outline">Export XLSX</button></div><p id="payment-activity-message" class="ops-message" role="status"></p><div class="table-scroll"><table><thead><tr><th>When</th><th>Action</th><th>Customer</th><th>Order</th><th>Invoice</th><th>Amount</th><th>Method</th><th>Actor</th><th>Changes / reason</th></tr></thead><tbody id="payment-activity-body"></tbody></table></div><div class="master-pagination"><button id="payment-activity-prev" type="button" class="button button-outline">Previous</button><span id="payment-activity-page">Page 1</span><button id="payment-activity-next" type="button" class="button button-outline">Next</button></div></div>`);
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
      if (action === 'submit') {
        const amount = Number(fields.get('amount')); if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('Enter a positive amount with at most two decimal places.');
        const invoice = invoices.find((row) => row.id === target);
        if (!invoice || Math.round(amount * 100) > invoice.totalPaise - invoice.verifiedPaidPaise) throw new Error('Payment exceeds the current outstanding balance. Refresh the invoice and try again.');
        if (fields.get('mode') !== 'cash' && !String(fields.get('reference') || '').trim()) throw new Error('UPI and bank transfers require a transaction reference.');
        await callOperation(functions, 'submitPayment', { invoiceId: target, amountPaise: Math.round(amount * 100), mode: fields.get('mode'), transactionNumber: fields.get('mode') === 'cash' ? '-' : fields.get('reference'), operationId: paymentOperationId });
        invoice.paymentStatus = 'in_process';
        renderInvoices();
      } else if (action === 'correct') {
        if (fields.get('mode') !== 'cash' && !String(fields.get('reference') || '').trim()) throw new Error('UPI and bank transfers require a transaction reference.');
        await callOperation(functions, 'changePaymentMode', { paymentId: target, mode: fields.get('mode'), transactionNumber: fields.get('mode') === 'cash' ? '-' : fields.get('reference'), reason: fields.get('reason') });
      }
      else await callOperation(functions, action === 'reject' ? 'reviewPayment' : 'reversePayment', action === 'reject' ? { paymentId: target, decision: 'rejected', reason: fields.get('reason') } : { paymentId: target, reason: fields.get('reason') });
      paymentOperationId = '';
      $('finance-dialog').close(); showToast(action === 'submit' ? 'Payment submitted for verification.' : 'Payment history updated.'); await refresh(); await loadPaymentActivity();
    } catch (error) { $('finance-error').textContent = message(error); $('finance-error').hidden = false; } finally { $('finance-save').disabled = false; $('finance-save').textContent = 'Save'; }
  });
  document.addEventListener('oms:pagechange', (event) => { if (['invoices', 'payments'].includes(event.detail.page)) refresh(); if (event.detail.page === 'payments') loadPaymentActivity(); });
  return { setSession(nextUser, nextProfile) { revision++; activityRevision++; user = nextUser; profile = nextProfile; invoices = []; payments = []; paymentsLoaded = false; resolvedNames = new Map(); paymentPage = 1; activityRows = []; activityPage = 1; activityCursors = [null]; if (user && profile) refresh(); else { $('invoice-body').innerHTML = ''; $('payment-body').innerHTML = ''; renderPaymentActivity(); } } };
}
