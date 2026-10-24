import { addDoc, collection, doc, getDocFromServer, getDocsFromServer, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { customerContactHash, normalizeCustomerContact } from './customer-validation.js';
import { saveCustomerDirect } from './customer-data.js';
import { IMPORT_FIELDS, importCounts, parseCsv, prepareCustomerRows, suggestMapping, workbookSheets } from './customer-import.js';
import { loadSheetJs } from './xlsx-export.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const note = (error) => error?.message || 'Import failed. Check your connection and retry.';
const isAdmin = (profile) => profile?.active === true && profile.role === 'admin';
const activeUsers = (rows) => rows.filter((row) => row.active === true && ['admin', 'account_admin', 'user'].includes(row.role));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const sha256 = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function initCustomerImport({ db, auth }) {
  let profile = null, sheets = [], fileBytes = null, rows = [], users = [], running = false, generation = 0, previewRevision = 0, rowPage = 1, jobId = '';
  const dialog = $('customer-import-dialog');
  const status = (value) => { $('customer-import-message').textContent = value; };
  const resultTable = () => {
    const counts = importCounts(rows);
    $('customer-import-counts').innerHTML = Object.entries({ 'Rows processed': counts.processed, 'Valid new': rows.filter((row) => row.status === 'valid').length, 'Imported': counts.imported, 'Existing': counts.existing, 'Duplicate rows': counts.duplicate, 'Invalid': counts.invalid, 'Failed': counts.failed }).map(([label, value]) => `<div class="card ops-stat"><span>${esc(label)}</span><strong>${value}</strong></div>`).join('');
    const pages = Math.max(1, Math.ceil(rows.length / 100)); rowPage = Math.min(rowPage, pages);
    $('customer-import-rows').innerHTML = rows.slice((rowPage - 1) * 100, rowPage * 100).map((row) => `<tr><td>${row.rowNumber}</td><td>${esc(row.input?.fullName || row.displayName)}</td><td>${esc(row.input?.contact || row.displayContact)}</td><td>${esc(users.find((user) => user.id === row.input?.assignedUserId)?.displayName || users.find((user) => user.id === row.input?.assignedUserId)?.fullName || 'Unassigned')}</td><td>${esc(row.status)}${row.reason ? `: ${esc(row.reason)}` : ''}</td></tr>`).join('');
    $('customer-import-page').textContent = `Page ${rowPage} of ${pages}`;
    $('customer-import-prev').disabled = rowPage === 1;
    $('customer-import-next').disabled = rowPage === pages;
    $('customer-import-results').hidden = false;
    $('customer-import-run').disabled = running || !rows.some((row) => row.status === 'valid' || row.status === 'failed');
  };
  const mapping = () => Object.fromEntries(IMPORT_FIELDS.map((field) => {
    const value = $(`customer-import-map-${field.key}`).value;
    return [field.key, value === '' ? '' : Number(value)];
  }));
  const showMapping = (headers) => {
    const proposed = suggestMapping(headers);
    $('customer-import-mapping').innerHTML = IMPORT_FIELDS.map((field) => `<label class="customer-import-file">${esc(field.label)}${field.required ? ' *' : ''}<select id="customer-import-map-${field.key}"><option value="">Do not import</option>${headers.map((header, index) => `<option value="${index}" ${proposed[field.key] === index ? 'selected' : ''}>${esc(header || `Column ${index + 1}`)}</option>`).join('')}</select></label>`).join('');
    $('customer-import-mapping').hidden = false;
    $('customer-import-preview').disabled = false;
    $('customer-import-results').hidden = true;
    $('customer-import-run').disabled = true;
  };
  const selectedSheet = () => sheets[Number($('customer-import-sheet').value) || 0];
  const invalidatePreview = () => { previewRevision++; rowPage = 1; $('customer-import-results').hidden = true; $('customer-import-run').disabled = true; rows = []; jobId = ''; };
  const loadFile = async () => {
    const file = $('customer-import-file').files?.[0];
    if (!file) return;
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) throw new Error('Choose a CSV or Excel file.');
    if (file.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB. Split it into smaller files.');
    fileBytes = await file.arrayBuffer();
    if (/\.csv$/i.test(file.name)) sheets = [{ name: 'CSV', rows: parseCsv(await file.text()) }];
    else sheets = workbookSheets(fileBytes, await loadSheetJs());
    $('customer-import-sheet').innerHTML = sheets.map((sheet, index) => `<option value="${index}">${esc(sheet.name)}</option>`).join('');
    $('customer-import-sheet-wrap').hidden = sheets.length === 1;
    showMapping(selectedSheet().rows[0] || []);
    status(`${sheets.length} sheet${sheets.length === 1 ? '' : 's'} loaded. Map columns, then validate.`);
  };
  async function preview() {
    const revision = ++previewRevision;
    if (!isAdmin(profile) || auth.currentUser?.uid == null) throw new Error('Only an active Admin can import customers.');
    const selected = selectedSheet();
    if (!selected) throw new Error('Select a file and sheet.');
    const defaultUserId = $('customer-import-default-user').value || null;
    rows = prepareCustomerRows(selected.rows, mapping(), users, defaultUserId);
    const suffix = new TextEncoder().encode(JSON.stringify({ sheet: selected.name, mapping: mapping(), defaultUserId }));
    const source = new Uint8Array(fileBytes.byteLength + suffix.length);
    source.set(new Uint8Array(fileBytes)); source.set(suffix, fileBytes.byteLength);
    jobId = await sha256(source);
    const existingSnap = await getDocsFromServer(collection(db, 'customers'));
    const existing = new Set(existingSnap.docs.map((entry) => normalizeCustomerContact(entry.data().contact)));
    const candidates = rows.filter((row) => row.status === 'valid');
    for (let offset = 0; offset < candidates.length; offset += 8) {
      await Promise.all(candidates.slice(offset, offset + 8).map(async (row) => {
        const normalized = normalizeCustomerContact(row.input.contact);
        if (existing.has(normalized)) { row.status = 'existing'; row.reason = 'Contact already belongs to a customer.'; return; }
        const key = await customerContactHash(row.input.contact);
        const reservation = await getDocFromServer(doc(db, 'customerContacts', key));
        if (reservation.exists()) { row.status = 'existing'; row.reason = 'Contact is already reserved.'; }
      }));
    }
    if (revision !== previewRevision) return;
    resultTable();
    status('Preview complete. Check the counts and row reasons before importing.');
  }
  async function run() {
    if (running || !isAdmin(profile) || auth.currentUser?.uid == null) return;
    const candidates = rows.filter((row) => row.status === 'valid' || row.status === 'failed');
    if (!candidates.length) return;
    if ($('customer-import-duplicates').value === 'stop' && rows.some((row) => row.status === 'duplicate')) { status('Duplicate rows were found. Correct the file or choose Skip duplicate rows.'); return; }
    if (!window.confirm(`Import ${candidates.length} new customer row${candidates.length === 1 ? '' : 's'}? Existing and invalid rows will be skipped.`)) return;
    running = true; $('customer-import-run').disabled = true; $('customer-import-close').disabled = true;
    const currentGeneration = generation;
    try {
      for (let index = 0; index < candidates.length; index++) {
        if (currentGeneration !== generation || !isAdmin(profile)) throw new Error('Import stopped because the signed-in account changed.');
        const row = candidates[index];
        const key = await customerContactHash(row.input.contact);
        const customerId = `import_${key}`;
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const saved = await saveCustomerDirect(db, auth, row.input, { customerId, create: true, importReference: { jobId, rowNumber: row.rowNumber } });
            row.status = saved.alreadySaved ? 'existing' : 'imported'; row.reason = saved.alreadySaved ? 'Already imported by this account.' : '';
            lastError = null; break;
          } catch (error) {
            lastError = error;
            if (!['unavailable', 'deadline-exceeded', 'aborted'].includes(String(error.code || '').replace(/^firestore\//, ''))) break;
            await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
          }
        }
        if (lastError) {
          row.status = /already exists|contact already|already saved/i.test(note(lastError)) ? 'existing' : 'failed';
          row.reason = note(lastError);
        }
        if ((index + 1) % 25 === 0 || index + 1 === candidates.length) { status(`Processed ${index + 1} of ${candidates.length} import candidates.`); resultTable(); await pause(); }
      }
      const counts = importCounts(rows);
      let auditWarning = '';
      try { await addDoc(collection(db, 'auditLogs'), { type: 'customer.import_completed', actorUid: auth.currentUser.uid, referenceType: 'customerImport', referenceId: jobId, detail: counts, at: serverTimestamp() }); }
      catch (error) { auditWarning = ` Import summary audit could not be saved: ${note(error)}.`; }
      const assignedCounts = new Map();
      for (const row of rows) if (row.status === 'imported' && row.input.assignedUserId) assignedCounts.set(row.input.assignedUserId, (assignedCounts.get(row.input.assignedUserId) || 0) + 1);
      const assigned = [...assignedCounts].map(([id, count]) => `${users.find((user) => user.id === id)?.displayName || users.find((user) => user.id === id)?.fullName || id}: ${count}`).join(', ');
      status(`Completed: ${counts.processed} rows; ${counts.imported} imported, ${counts.existing} existing, ${counts.duplicate} duplicate, ${counts.invalid} invalid, ${counts.failed} failed.${assigned ? ` Assigned: ${assigned}.` : ''}${auditWarning}`);
      document.dispatchEvent(new CustomEvent('oms:pagechange', { detail: { page: 'customers' } }));
    } catch (error) { status(`Import stopped: ${note(error)}. Review failed rows and retry the same file.`); }
    finally { running = false; $('customer-import-close').disabled = false; resultTable(); }
  }
  $('customer-import-open').addEventListener('click', async () => {
    if (!isAdmin(profile)) return;
    invalidatePreview();
    rows = []; sheets = []; fileBytes = null; jobId = '';
    $('customer-import-duplicates').value = 'skip';
    $('customer-import-file').value = '';
    $('customer-import-mapping').hidden = true; $('customer-import-sheet-wrap').hidden = true; $('customer-import-results').hidden = true;
    $('customer-import-preview').disabled = true; $('customer-import-run').disabled = true;
    status('Loading active users…'); dialog.showModal();
    try {
      const snapshot = await getDocsFromServer(collection(db, 'users'));
      users = activeUsers(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
      $('customer-import-default-user').innerHTML = '<option value="">Unassigned</option>' + users.map((user) => `<option value="${esc(user.id)}">${esc(user.displayName || user.fullName || user.email || user.id)}</option>`).join('');
      status('Select a file. The default assignment is Unassigned.');
    } catch (error) { status(`Could not load active users: ${note(error)}`); }
  });
  $('customer-import-template').addEventListener('click', () => {
    const headers = IMPORT_FIELDS.map((field) => `"${field.label.replace(/"/g, '""')}"`).join(',');
    const url = URL.createObjectURL(new Blob([`\uFEFF${headers}\r\n`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'suhrad-customer-import-template.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('customer-import-file').addEventListener('change', async () => { try { invalidatePreview(); sheets = []; fileBytes = null; status('Reading file…'); await loadFile(); } catch (error) { status(note(error)); } });
  $('customer-import-sheet').addEventListener('change', () => showMapping(selectedSheet().rows[0] || []));
  $('customer-import-mapping').addEventListener('change', invalidatePreview);
  $('customer-import-default-user').addEventListener('change', invalidatePreview);
  $('customer-import-preview').addEventListener('click', async () => { try { status('Checking customers and contact reservations…'); await preview(); } catch (error) { status(note(error)); } });
  $('customer-import-run').addEventListener('click', run);
  $('customer-import-prev').addEventListener('click', () => { if (rowPage > 1) { rowPage--; resultTable(); } });
  $('customer-import-next').addEventListener('click', () => { if (rowPage * 100 < rows.length) { rowPage++; resultTable(); } });
  $('customer-import-close').addEventListener('click', () => { if (!running) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (running) event.preventDefault(); });
  return { setSession(_user, nextProfile) { generation++; profile = nextProfile; $('customer-import-open').hidden = !isAdmin(profile); if (!isAdmin(profile) && dialog.open) dialog.close(); } };
}
