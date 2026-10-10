import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { getFreshInvoice, listInvoices, listPayments } from './finance-data.js';
import { downloadInvoicePdf } from './invoice-pdf.js';
import { downloadXlsx } from './xlsx-export.js';

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
  let user = null, profile = null, invoices = [], payments = [], revision = 0, action = '', target = '';
  const privileged = () => isStaff(profile);
  const matching = (kind) => {
    const rows = kind === 'invoice' ? invoices : payments;
    const search = $(`${kind}-search`).value.trim().toLowerCase(), status = $(`${kind}-status`).value, from = $(`${kind}-from`).value, to = $(`${kind}-to`).value;
    return rows.filter((row) => {
      const haystack = `${row.invoiceNumber} ${row.orderNumber} ${row.customerSnapshot?.fullName} ${row.customerSnapshot?.contact} ${row.transactionNumber || ''}`.toLowerCase();
      const day = iso(kind === 'invoice' ? row.issuedAt : row.submittedAt);
      return (!search || haystack.includes(search)) && (!status || (kind === 'invoice' ? row.paymentStatus : row.reversalId ? 'reversed' : row.verificationStatus) === status) && (!from || day >= from) && (!to || day <= to);
    }).sort((a, b) => (kind === 'invoice' ? b.issuedAt?.seconds - a.issuedAt?.seconds : b.submittedAt?.seconds - a.submittedAt?.seconds) || 0);
  };
  function renderInvoices() {
    const rows = matching('invoice');
    $('invoice-cards').innerHTML = stat('Visible invoices', rows.length) + stat('Outstanding', cash(rows.reduce((sum, row) => sum + row.totalPaise - row.verifiedPaidPaise, 0))) + stat('Verified payments', cash(rows.reduce((sum, row) => sum + row.verifiedPaidPaise, 0)));
    $('invoice-body').innerHTML = rows.length ? rows.map((row) => `<tr><td>${esc(row.invoiceNumber || `INV-${row.orderNumber}`)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.customerSnapshot?.fullName)}</td><td>${esc(date(row.issuedAt))}</td><td>${esc(cash(row.totalPaise))}</td><td>${esc(cash(row.verifiedPaidPaise))}</td><td>${esc(cash(row.totalPaise - row.verifiedPaidPaise))}</td><td>${esc(row.paymentStatus)}</td><td class="ops-actions"><button type="button" data-finance="pdf" data-id="${esc(row.id)}">PDF</button>${row.paymentStatus !== 'paid' && row.totalPaise > row.verifiedPaidPaise ? `<button type="button" data-finance="submit" data-id="${esc(row.id)}">Add payment</button>` : ''}${profile?.role === 'account_admin' && row.paymentStatus === 'ready_to_mark_paid' ? `<button type="button" data-finance="paid" data-id="${esc(row.id)}">Mark as Paid</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="9" class="empty-cell">No invoices match your access or filters.</td></tr>';
  }
  function renderPayments() {
    const rows = matching('payment');
    $('payment-cards').innerHTML = stat('Submissions', rows.length) + stat('Awaiting review', rows.filter((row) => row.verificationStatus === 'unverified').length) + stat('Verified (not reversed)', cash(rows.filter((row) => row.verificationStatus === 'verified' && !row.reversalId).reduce((sum, row) => sum + row.amountPaise, 0)));
    $('payment-body').innerHTML = rows.length ? rows.map((row) => `<tr><td>${esc(date(row.submittedAt))}</td><td>${esc(row.customerSnapshot?.fullName)}</td><td>${esc(row.customerSnapshot?.contact)}</td><td><button type="button" class="ops-link" data-finance="order" data-id="${esc(row.orderNumber)}">${esc(row.orderNumber)}</button></td><td>${esc(row.invoiceNumber)}</td><td>${esc(cash(row.amountPaise))}</td><td>${esc(row.mode)}</td><td>${esc(row.transactionNumber)}</td><td>${esc(row.submittedBy)}</td><td>${esc(row.reversalId ? 'reversed' : row.verificationStatus)}</td><td>${esc(row.verifiedBy || '—')}${row.receivedBy ? `<small>Received: ${esc(row.receivedBy)}</small>` : ''}</td><td class="ops-actions">${privileged() && row.verificationStatus === 'unverified' ? `<button type="button" data-finance="verify" data-id="${esc(row.id)}">Verify</button><button type="button" data-finance="reject" data-id="${esc(row.id)}">Reject</button>` : ''}${privileged() && row.verificationStatus === 'verified' && !row.reversalId ? `<button type="button" data-finance="reverse" data-id="${esc(row.id)}">Reverse</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="12" class="empty-cell">No payments match your access or filters.</td></tr>';
  }
  async function refresh() {
    if (!user || !profile) return;
    const current = ++revision, owner = privileged() ? null : user.uid;
    $('invoice-message').textContent = 'Loading invoices…'; $('payment-message').textContent = 'Loading payments…';
    try {
      const [invoiceRows, paymentRows] = await Promise.all([listInvoices(db, owner), listPayments(db, owner)]);
      if (current !== revision) return;
      invoices = invoiceRows; payments = paymentRows; renderInvoices(); renderPayments(); $('invoice-message').textContent = ''; $('payment-message').textContent = '';
    } catch (error) { if (current === revision) { $('invoice-message').textContent = `Could not load invoices: ${message(error)}`; $('payment-message').textContent = `Could not load payments: ${message(error)}`; } }
  }
  function openDialog(kind, id) {
    action = kind; target = id; $('finance-error').hidden = true;
    const invoice = invoices.find((row) => row.id === id);
    $('finance-dialog-title').textContent = ({ submit: 'Submit payment', reject: 'Reject payment', reverse: 'Reverse verified payment' })[kind];
    $('finance-fields').innerHTML = kind === 'submit' ? `<p>Outstanding: <strong>${esc(cash(invoice.totalPaise - invoice.verifiedPaidPaise))}</strong>. Submissions count only after staff verification.</p><label class="ops-field">Amount (₹)<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="ops-field">Mode<select name="mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ops-field">Transaction reference<input name="reference" maxlength="100" placeholder="Cash uses -"></label>` : '<label class="ops-field">Reason<textarea name="reason" maxlength="500" required></textarea></label>';
    $('finance-dialog').showModal();
  }
  async function act(kind, id) {
    try {
      if (kind === 'order') { document.querySelector('[data-page="orders"]')?.click(); $('order-search').value = id; $('order-search').dispatchEvent(new Event('input')); return; }
      if (kind === 'pdf') { const invoice = await getFreshInvoice(db, id); if (!privileged() && invoice.ownerUid !== user.uid) throw new Error('Invoice access denied.'); await downloadInvoicePdf(invoice); return; }
      if (['submit', 'reject', 'reverse'].includes(kind)) { openDialog(kind, id); return; }
      if (kind === 'paid') await callOperation(functions, 'markInvoicePaid', { invoiceId: id });
      if (kind === 'verify') await callOperation(functions, 'reviewPayment', { paymentId: id, decision: 'verified' });
      showToast(kind === 'paid' ? 'Invoice marked paid.' : 'Payment verified.'); await refresh();
    } catch (error) { showToast(message(error), 'toast-error'); }
  }
  ['invoice', 'payment'].forEach((kind) => {
    ['search', 'status', 'from', 'to'].forEach((field) => $(`${kind}-${field}`).addEventListener('input', () => kind === 'invoice' ? renderInvoices() : renderPayments()));
    $(`${kind}-body`).addEventListener('click', (event) => { const button = event.target.closest('[data-finance]'); if (button) act(button.dataset.finance, button.dataset.id); });
    $(`${kind}-export`).addEventListener('click', () => exportRows(kind === 'invoice' ? 'Invoices' : 'Payments', matching(kind).map((row) => kind === 'invoice' ? { Invoice: row.invoiceNumber, Order: row.orderNumber, Customer: row.customerSnapshot?.fullName, Date: date(row.issuedAt), Total: row.totalPaise / 100, Verified: row.verifiedPaidPaise / 100, Balance: (row.totalPaise - row.verifiedPaidPaise) / 100, Status: row.paymentStatus } : { Submitted: date(row.submittedAt), Customer: row.customerSnapshot?.fullName, Contact: row.customerSnapshot?.contact, Order: row.orderNumber, Invoice: row.invoiceNumber, Amount: row.amountPaise / 100, Mode: row.mode, Reference: row.transactionNumber, SubmittedBy: row.submittedBy, Status: row.reversalId ? 'reversed' : row.verificationStatus, Verifier: row.verifiedBy })));
  });
  $('finance-dialog-close').onclick = $('finance-cancel').onclick = () => $('finance-dialog').close();
  $('finance-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('finance-save').disabled = true; $('finance-error').hidden = true;
    try {
      const fields = new FormData(event.currentTarget);
      if (action === 'submit') {
        const amount = Number(fields.get('amount')); if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('Enter a positive amount with at most two decimal places.');
        await callOperation(functions, 'submitPayment', { invoiceId: target, amountPaise: Math.round(amount * 100), mode: fields.get('mode'), transactionNumber: fields.get('reference') });
      } else await callOperation(functions, action === 'reject' ? 'reviewPayment' : 'reversePayment', action === 'reject' ? { paymentId: target, decision: 'rejected', reason: fields.get('reason') } : { paymentId: target, reason: fields.get('reason') });
      $('finance-dialog').close(); showToast(action === 'submit' ? 'Payment submitted for verification.' : 'Payment history updated.'); await refresh();
    } catch (error) { $('finance-error').textContent = message(error); $('finance-error').hidden = false; } finally { $('finance-save').disabled = false; }
  });
  document.addEventListener('oms:pagechange', (event) => { if (['invoices', 'payments'].includes(event.detail.page)) refresh(); });
  return { setSession(nextUser, nextProfile) { revision++; user = nextUser; profile = nextProfile; invoices = []; payments = []; if (user && profile) refresh(); else { $('invoice-body').innerHTML = ''; $('payment-body').innerHTML = ''; } } };
}
