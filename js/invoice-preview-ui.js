import { collection, doc, getDoc, getDocs, query, setDoc, serverTimestamp, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { canAccessPage, isStaff } from './permissions.js';
import { listOrderProducts } from './order-data.js';
import { readBusinessDetails } from './master-data.js';
import { createInvoicePdfBlob, invoicePreviewHtml } from './invoice-pdf.js';
import { previewAmountWords, previewFilename, previewInvoice, previewProductLine, previewTotal, previewUnits, validatePreview } from './invoice-preview-model.js';
import { sharePreviewPdf } from './invoice-preview-share.js';
import { uniqueId } from './unique-id.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (stamp) => { const date = stamp?.toDate?.() || (stamp instanceof Date ? stamp : null); return date ? date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date unavailable'; };
const download = (blob, filename) => { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); };

export function initInvoicePreviewUi({ db }) {
  let user = null, profile = null, items = [], specials = [], records = [], current = null, lines = [], business = {}, busy = false, generated = null;
  const form = $('invoice-preview-form');
  const field = (name) => form.elements.namedItem(name);
  const notice = (message) => { $('invoice-preview-message').textContent = message; };
  const invalidatePdf = () => { generated = null; $('invoice-proposal-share').disabled = true; $('invoice-preview-document').hidden = true; };
  const item = (kind, id) => (kind === 'special' ? specials : items).find((entry) => entry.id === id);
  const choices = (product, line) => {
    const available = previewUnits(product, profile?.role, line.kind || 'item');
    return `${!available.some((unit) => unit.id === line.unitId) ? `<option value="${esc(line.unitId)}" selected>${esc(line.unit)} (saved price)</option>` : ''}${available.map((unit) => `<option value="${unit.id}" ${line.unitId === unit.id ? 'selected' : ''}>${esc(unit.label)}</option>`).join('')}`;
  };
  const itemChoices = (line) => {
    const kind = line.kind || 'item';
    const saved = item(kind, line.productId) ? '' : `<option value="${esc(kind)}:${esc(line.productId)}" selected>${esc(line.description)} (saved item)</option>`;
    const options = (products, groupKind) => products.map((product) => `<option value="${groupKind}:${esc(product.id)}" ${kind === groupKind && line.productId === product.id ? 'selected' : ''}>${esc(product.name)}</option>`).join('');
    return `${saved}<optgroup label="Regular Items">${options(items, 'item')}</optgroup><optgroup label="Special Items">${options(specials, 'special')}</optgroup>`;
  };
  function renderLines() {
    $('invoice-preview-lines').innerHTML = lines.map((line, index) => {
      const product = item(line.kind || 'item', line.productId);
      return `<div class="invoice-preview-line" data-index="${index}"><label class="ops-field invoice-preview-product">Item<select data-line-field="productId">${itemChoices(line)}</select></label><label class="ops-field">Unit<select data-line-field="unitId">${product ? choices(product, line) : `<option value="${esc(line.unitId)}">${esc(line.unit)} (saved price)</option>`}</select></label><label class="ops-field">Quantity<input data-line-field="quantity" type="number" min="1" step="1" value="${line.quantityQty / 1000}"></label><span class="invoice-preview-amount">Rate<strong>${money(line.unitPricePaise)}</strong></span><span class="invoice-preview-amount">Total<strong>${money(line.lineTotalPaise)}</strong></span><button type="button" class="button button-outline invoice-preview-remove" data-remove-preview-line="${index}">Remove</button></div>`;
    }).join('');
    const total = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    $('invoice-preview-total').textContent = money(total);
    $('invoice-preview-words').textContent = previewAmountWords({ totalPaise: total });
  }
  function makeLine(kind, productId, unitId, quantityQty = 1000) {
    const product = item(kind, productId), unit = previewUnits(product, profile?.role, kind).find((entry) => entry.id === unitId);
    if (!product || !unit) throw new Error('Choose an available item and unit.');
    return previewProductLine(product, kind, unitId, quantityQty);
  }
  function reset() {
    current = null; form.reset(); lines = []; invalidatePdf(); renderLines(); $('invoice-preview-reference').textContent = 'New preview'; notice('');
  }
  async function load() {
    if (!user || !canAccessPage(profile, 'invoicePreviews')) return;
    notice('Loading previews…');
    try {
      const [products, specialProducts, snapshots, details] = await Promise.all([listOrderProducts(db, 'items', isStaff(profile)), listOrderProducts(db, 'specialProducts', isStaff(profile)), getDocs(isStaff(profile) ? collection(db, 'invoicePreviews') : query(collection(db, 'invoicePreviews'), where('ownerUid', '==', user.uid))), readBusinessDetails(db)]);
      items = products.filter((entry) => entry.active === true); specials = specialProducts.filter((entry) => entry.active === true); records = snapshots.docs.map((entry) => ({ id: entry.id, ...entry.data() })).sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)); business = details;
      $('invoice-preview-history').innerHTML = records.length ? records.map((record) => `<article class="mobile-record-card invoice-preview-record"><div class="mobile-record-top"><strong>${esc(record.customerSnapshot?.fullName || 'Customer')}</strong><span>${esc(shortDate(record.createdAt))}</span></div><div class="mobile-record-bottom"><b>${money(record.totalPaise)}</b><small>${esc(record.reference)}</small></div><div class="mobile-record-actions"><button type="button" data-view-preview="${esc(record.id)}">View</button><button type="button" data-edit-preview="${esc(record.id)}">Edit</button><button type="button" data-generate-preview="${esc(record.id)}">Generate PDF</button></div></article>`).join('') : '<p class="mobile-record-empty">No previews saved yet.</p>';
      notice('');
    } catch (error) { notice(error.message || 'Previews could not be loaded.'); }
  }
  function inputRecord() {
    return validatePreview({ customerSnapshot: { fullName: field('fullName').value, contact: field('contact').value, area: field('area').value, address: field('address').value }, lines });
  }
  async function save() {
    if (busy) return null;
    busy = true;
    try {
      const values = inputRecord(); const id = current?.id || uniqueId();
      invalidatePdf();
      const record = { ...values, ownerUid: current?.ownerUid || user.uid, reference: current?.reference || `PREV-${id.slice(0, 12).toUpperCase()}`, createdAt: current?.createdAt || serverTimestamp(), updatedAt: serverTimestamp() };
      const ref = doc(db, 'invoicePreviews', id);
      await setDoc(ref, record);
      const saved = await getDoc(ref);
      current = { id, ...saved.data() };
      notice('Preview saved. It has no effect on orders or stock.'); await load(); return current;
    } catch (error) { notice(error.message || 'Preview could not be saved.'); return null; }
    finally { busy = false; }
  }
  async function pdf() {
    const record = await save(); if (!record) return null;
    const blob = await createInvoicePdfBlob(previewInvoice(record), business);
    generated = { record, blob, filename: previewFilename(record) };
    $('invoice-proposal-share').disabled = false;
    return generated;
  }
  form.addEventListener('input', invalidatePdf);
  form.addEventListener('submit', async (event) => { event.preventDefault(); await save(); });
  const addLine = (kind) => { try { const products = kind === 'special' ? specials : items; const product = products.find((entry) => previewUnits(entry, profile?.role, kind).length); if (!product) throw new Error(`No priced ${kind === 'special' ? 'Special Items' : 'Regular Items'} are available.`); lines.push(makeLine(kind, product.id, previewUnits(product, profile?.role, kind)[0].id)); invalidatePdf(); renderLines(); } catch (error) { notice(error.message); } };
  $('invoice-preview-add').addEventListener('click', () => addLine('item'));
  $('invoice-preview-add-special').addEventListener('click', () => addLine('special'));
  $('invoice-preview-lines').addEventListener('change', (event) => {
    const row = event.target.closest('[data-index]'); if (!row) return;
    const index = Number(row.dataset.index), old = lines[index];
    try {
      if (event.target.dataset.lineField === 'productId') { const [kind, productId] = event.target.value.split(':'); const product = item(kind, productId); lines[index] = makeLine(kind, product.id, previewUnits(product, profile?.role, kind)[0]?.id, old.quantityQty); }
      else if (event.target.dataset.lineField === 'unitId') lines[index] = makeLine(old.kind || 'item', old.productId, event.target.value, old.quantityQty);
      else if (event.target.dataset.lineField === 'quantity') lines[index] = { ...old, quantityQty: Number(event.target.value) * 1000, lineTotalPaise: previewTotal(Number(event.target.value) * 1000, old.unitPricePaise) };
      invalidatePdf(); renderLines(); notice('');
    } catch (error) { notice(error.message); renderLines(); }
  });
  $('invoice-preview-lines').addEventListener('click', (event) => { const button = event.target.closest('[data-remove-preview-line]'); if (button) { lines.splice(Number(button.dataset.removePreviewLine), 1); invalidatePdf(); renderLines(); } });
  $('invoice-preview-refresh').addEventListener('click', () => { try { lines = lines.map((line) => makeLine(line.kind || 'item', line.productId, line.unitId, line.quantityQty)); invalidatePdf(); renderLines(); notice('Current item prices applied. Save to keep them.'); } catch (error) { notice(error.message); } });
  $('invoice-preview-new').addEventListener('click', reset);
  $('invoice-preview-history').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-edit-preview],[data-view-preview],[data-generate-preview]');
    if (!button) return;
    const id = button.dataset.editPreview || button.dataset.viewPreview || button.dataset.generatePreview;
    const record = records.find((row) => row.id === id); if (!record) return;
    if (button.dataset.editPreview) { current = record; invalidatePdf(); for (const key of ['fullName', 'contact', 'area', 'address']) field(key).value = record.customerSnapshot?.[key] || ''; lines = record.lines.map((line) => ({ ...line })); $('invoice-preview-reference').textContent = record.reference; renderLines(); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); notice('Saved prices retained. Use Refresh Current Prices only if you want to update them.'); return; }
    if (button.dataset.viewPreview) { $('invoice-preview-document').innerHTML = invoicePreviewHtml(previewInvoice(record), business); $('invoice-preview-document').hidden = false; $('invoice-preview-document').scrollIntoView({ behavior: 'smooth', block: 'start' }); notice('Viewing the saved preview.'); return; }
    try { const blob = await createInvoicePdfBlob(previewInvoice(record), business); download(blob, previewFilename(record)); notice('Saved preview PDF downloaded.'); }
    catch (error) { notice(error.message || 'PDF could not be generated.'); }
  });
  $('invoice-preview-generate').addEventListener('click', async () => { try { const result = await pdf(); if (!result) return; download(result.blob, result.filename); $('invoice-preview-document').innerHTML = invoicePreviewHtml(previewInvoice(result.record), business); $('invoice-preview-document').hidden = false; notice('PDF downloaded. Preview shown below.'); } catch (error) { notice(error.message || 'PDF could not be generated.'); } });
  $('invoice-proposal-share').addEventListener('click', async () => {
    try {
      const result = generated; if (!result) { notice('Generate the PDF before sharing.'); return; }
      const method = await sharePreviewPdf(result.record, result.blob, result.filename, { browserNavigator: navigator, FileType: globalThis.File, download });
      notice(method === 'shared' ? 'Share sheet opened with the PDF. Choose WhatsApp to send it.' : method === 'manual' ? 'WhatsApp opened and the PDF downloaded. Attach the downloaded file manually.' : 'PDF downloaded. Open WhatsApp and attach the downloaded file manually.');
    } catch (error) { if (error?.name !== 'AbortError') notice(error.message || 'Sharing failed.'); }
  });
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'invoicePreviews') void load(); });
  return { setSession(nextUser, nextProfile) { user = nextUser; profile = nextProfile; if (!user) { items = []; specials = []; records = []; reset(); $('invoice-preview-history').innerHTML = ''; $('invoice-preview-document').hidden = true; } } };
}
