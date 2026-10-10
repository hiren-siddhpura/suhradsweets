import { listMasterRecords, saveMasterRecord, deactivateMasterRecord, readDashboardTarget, saveDashboardTarget } from './master-data.js';
import { MASTER_LABELS } from './master-validation.js';
import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { sendUserSetupEmail } from './auth.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;
const titles = { items: 'Items', units: 'Units', purchaseTypes: 'Purchase Types', users: 'Users', settings: 'Settings' };
const subtitles = {
  items: 'Manage items, prices and default units.', units: 'Manage units used by items and transactions.',
  purchaseTypes: 'Manage purchase categories.', users: 'Manage user accounts and roles through the trusted backend.',
  settings: 'Store non-secret application settings.',
};
const columns = {
  items: [['itemCode', 'Code'], ['name', 'Name'], ['defaultSellingPrice', 'Selling price'], ['defaultUnitId', 'Unit']],
  units: [['name', 'Name'], ['symbol', 'Symbol']],
  purchaseTypes: [['name', 'Name'], ['description', 'Description']],
  users: [['displayName', 'Name'], ['role', 'Role'], ['email', 'Email']],
  settings: [['key', 'Key'], ['value', 'Value']],
};

function friendlyError(error) {
  if (error?.code === 'permission-denied') return 'Access was denied by Firestore rules. Check your role and refresh.';
  if (error?.code === 'unavailable') return 'Firestore is unavailable. Check your connection and try again.';
  return error?.message || 'The operation could not be completed.';
}

function field(name, label, { type = 'text', required = false, max = 120, value = '', readonly = false } = {}) {
  const wrapper = document.createElement('label');
  wrapper.className = 'master-field';
  wrapper.textContent = label;
  const input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (type !== 'textarea') input.type = type;
  input.name = name;
  input.value = value ?? '';
  input.required = required;
  input.readOnly = readonly;
  if (type === 'number') { input.min = '0'; input.step = '0.01'; }
  else input.maxLength = max;
  wrapper.append(input);
  return wrapper;
}

function selectField(name, label, options, value) {
  const wrapper = document.createElement('label');
  wrapper.className = 'master-field';
  wrapper.textContent = label;
  const select = document.createElement('select');
  select.name = name;
  select.required = true;
  for (const optionData of options) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    select.append(option);
  }
  select.value = value ?? '';
  wrapper.append(select);
  return wrapper;
}

function activeField(value) {
  const wrapper = document.createElement('label');
  wrapper.className = 'master-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox'; input.name = 'active'; input.checked = value !== false;
  wrapper.append(input, document.createTextNode('Active'));
  return wrapper;
}

export function initMasterData({ db, functions, auth, mode }) {
  let session = null;
  let type = 'items';
  let records = [];
  let unitNames = new Map();
  let page = 1;
  let loadRevision = 0;
  let editing = null, userOperationId = '', saving = false;
  const deactivationOperations = new Map();
  const dialog = $('master-dialog');

  function message(text, error = false) {
    $('master-message').textContent = text;
    $('master-message').classList.toggle('is-error', error);
    $('master-message').hidden = !text;
  }

  function recordName(record) { return record.name || record.displayName || record.fullName || record.key || record.itemCode || record.id || ''; }

  function visibleRecords() {
    const search = $('master-search').value.trim().toLocaleLowerCase();
    const status = $('master-status').value;
    const result = records.filter((record) => {
      if (status !== 'all' && (record.active === true ? 'active' : 'inactive') !== status) return false;
      if (!search) return true;
      return [recordName(record), record.itemCode, record.symbol, record.description, record.email, record.role, record.id]
        .some((part) => String(part ?? '').toLocaleLowerCase().includes(search));
    });
    const sort = $('master-sort').value;
    result.sort((a, b) => {
      if (sort === 'newest') return (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
      const order = recordName(a).localeCompare(recordName(b), undefined, { sensitivity: 'base' });
      return sort === 'name-desc' ? -order : order;
    });
    return result;
  }

  function render() {
    const header = $('master-table-head');
    const body = $('master-table-body');
    header.replaceChildren(); body.replaceChildren();
    const headRow = document.createElement('tr');
    for (const [, label] of columns[type]) { const th = document.createElement('th'); th.textContent = label; headRow.append(th); }
    for (const label of ['Status', 'Actions']) { const th = document.createElement('th'); th.textContent = label; headRow.append(th); }
    header.append(headRow);
    const filtered = visibleRecords();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages);
    const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!shown.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = columns[type].length + 2; cell.className = 'empty-cell';
      cell.textContent = records.length ? 'No records match your search or filters.' : `No ${titles[type].toLowerCase()} yet.`;
      row.append(cell); body.append(row);
    }
    for (const record of shown) {
      const row = document.createElement('tr');
      for (const [key] of columns[type]) {
        const cell = document.createElement('td');
        let value = record[key] ?? (key === 'displayName' ? record.fullName : undefined);
        if (key === 'defaultSellingPrice') value = `₹${Number(value || 0).toFixed(2)}`;
        if (key === 'defaultUnitId') value = unitNames.get(value) || value || '—';
        if (key === 'role') value = ({ admin: 'Admin', account_admin: 'Account Admin', user: 'User' })[value] || value;
        cell.textContent = String(value ?? '—'); row.append(cell);
      }
      const status = document.createElement('td');
      const badge = document.createElement('span'); badge.className = `master-status ${record.active ? 'is-active' : ''}`;
      badge.textContent = record.active ? 'Active' : 'Inactive'; status.append(badge); row.append(status);
      const actions = document.createElement('td'); actions.className = 'master-actions';
      const canEdit = !(type === 'users' && (record.id === session?.uid || (session?.role === 'account_admin' && record.role !== 'user')));
      if (canEdit) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'text-button'; edit.textContent = 'Edit';
        edit.addEventListener('click', () => openEditor(record)); actions.append(edit);
        if (type === 'users' && mode === 'emulator' && record.email && record.active) {
          const setup = document.createElement('button'); setup.type = 'button'; setup.className = 'text-button'; setup.textContent = 'Send password setup';
          setup.addEventListener('click', async () => {
            setup.disabled = true;
            try { await sendUserSetupEmail(auth, record.email); showToast('Password setup requested. Check the Auth emulator for the email action.'); }
            catch { message('Password setup could not be sent. The saved account remains unchanged.', true); }
            finally { setup.disabled = false; }
          }); actions.append(setup);
        }
        if (record.active) {
          const deactivate = document.createElement('button'); deactivate.type = 'button'; deactivate.className = 'text-button danger-link'; deactivate.textContent = 'Deactivate';
          deactivate.addEventListener('click', () => deactivateRecord(record)); actions.append(deactivate);
        }
      } else actions.textContent = '—';
      row.append(actions); body.append(row);
    }
    $('master-count').textContent = `${filtered.length} record${filtered.length === 1 ? '' : 's'}`;
    $('master-page-label').textContent = `Page ${page} of ${totalPages}`;
    $('master-prev').disabled = page <= 1;
    $('master-next').disabled = page >= totalPages;
  }

  async function load() {
    if (!session || !isStaff(session.profile)) return;
    const revision = ++loadRevision;
    message(`Loading ${titles[type].toLowerCase()}…`);
    $('master-add').disabled = true;
    readDashboardTarget(db).then((value) => { if (revision === loadRevision) $('master-target-kg').value = value; }).catch((error) => { if (revision === loadRevision) $('master-target-message').textContent = friendlyError(error); });
    try {
      const [result, units] = await Promise.all([listMasterRecords(db, type), type === 'items' ? listMasterRecords(db, 'units') : Promise.resolve([])]);
      if (revision !== loadRevision) return;
      records = result;
      unitNames = new Map(units.map((unit) => [unit.id, `${unit.name} (${unit.symbol})`]));
      message(''); render();
    } catch (error) {
      if (revision !== loadRevision) return;
      records = []; render(); message(friendlyError(error), true);
    } finally {
      if (revision === loadRevision) { $('master-add').disabled = type === 'users' && mode !== 'emulator'; $('master-add').title = type === 'users' && mode !== 'emulator' ? 'Live account creation is unavailable until the trusted backend is configured.' : ''; }
    }
  }

  async function openEditor(record = null) {
    if (!session || !isStaff(session.profile)) return;
    if (saving || (type === 'users' && !record && mode !== 'emulator')) return;
    userOperationId = crypto.randomUUID();
    const editorType = type;
    editing = record;
    $('master-dialog-title').textContent = `${record ? 'Edit' : 'Add'} ${MASTER_LABELS[type].toLowerCase()}`;
    $('master-dialog-hint').textContent = type === 'users'
      ? 'Account setup uses the trusted backend. The user sets their password through Firebase password reset; no password is stored here.'
      : type === 'items' && record ? 'Item codes stay fixed to protect references and uniqueness.'
        : type === 'settings' ? 'Use settings for non-secret values only.' : '';
    $('master-form-error').hidden = true;
    const fields = $('master-form-fields'); fields.replaceChildren();
    if (type === 'items') {
      fields.append(field('itemCode', 'Item code', { required: true, max: 32, value: record?.itemCode, readonly: !!record }));
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('description', 'Description', { type: 'textarea', max: 500, value: record?.description }));
      fields.append(field('defaultSellingPrice', 'Default selling price (₹)', { type: 'number', required: true, value: record?.defaultSellingPrice ?? 0 }));
      try {
        const units = await listMasterRecords(db, 'units');
        if (!session || !isStaff(session.profile) || type !== editorType) return;
        const options = [{ value: '', label: 'Select a unit' }, ...units.filter((unit) => unit.active || unit.id === record?.defaultUnitId).map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.symbol})${unit.active ? '' : ' — inactive'}` }))];
        fields.append(selectField('defaultUnitId', 'Default unit', options, record?.defaultUnitId));
      } catch (error) { message(friendlyError(error), true); return; }
    } else if (type === 'units') {
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('symbol', 'Symbol', { required: true, max: 16, value: record?.symbol }));
    } else if (type === 'purchaseTypes') {
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('description', 'Description', { type: 'textarea', max: 500, value: record?.description }));
    } else if (type === 'users') {
      fields.append(field('email', 'Email', { type: 'email', required: true, max: 254, value: record?.email }));
      fields.append(field('fullName', 'Full name', { required: true, max: 80, value: record?.displayName || record?.fullName }));
      const options = session.role === 'admin'
        ? [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }, { value: 'account_admin', label: 'Account Admin' }]
        : [{ value: 'user', label: 'User' }];
      fields.append(selectField('role', 'Role', options, record?.role || 'user'));
    } else {
      fields.append(field('key', 'Key', { required: true, max: 80, value: record?.key, readonly: !!record }));
      fields.append(field('value', 'Value', { required: true, max: 1000, value: record?.value }));
      fields.append(field('description', 'Description', { type: 'textarea', max: 500, value: record?.description }));
    }
    fields.append(activeField(record?.active));
    dialog.showModal();
  }

  async function deactivateRecord(record) {
    if (!session || !isStaff(session.profile)) return;
    if (!window.confirm(`Deactivate ${MASTER_LABELS[type].toLowerCase()} “${recordName(record)}”? Existing references will be kept.`)) return;
    try {
      if (type === 'users' && !deactivationOperations.has(record.id)) deactivationOperations.set(record.id, crypto.randomUUID());
      await deactivateMasterRecord(db, type, record.id, session, functions, deactivationOperations.get(record.id));
      deactivationOperations.delete(record.id);
      showToast(`${MASTER_LABELS[type]} deactivated.`);
      await load();
    } catch (error) { message(friendlyError(error), true); }
  }

  document.querySelectorAll('[data-master-tab]').forEach((button) => button.addEventListener('click', () => {
    type = button.dataset.masterTab; page = 1; $('master-search').value = ''; $('master-status').value = 'all';
    document.querySelectorAll('[data-master-tab]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('is-active', selected); tab.setAttribute('aria-selected', String(selected));
    });
    $('master-title').textContent = titles[type]; $('master-subtitle').textContent = subtitles[type];
    $('master-add').textContent = `Add ${MASTER_LABELS[type].toLowerCase()}`;
    load();
  }));
  $('master-search').addEventListener('input', () => { page = 1; render(); });
  $('master-status').addEventListener('change', () => { page = 1; render(); });
  $('master-sort').addEventListener('change', () => { page = 1; render(); });
  $('master-prev').addEventListener('click', () => { page--; render(); });
  $('master-next').addEventListener('click', () => { page++; render(); });
  $('master-refresh').addEventListener('click', load);
  $('master-target-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('master-target-save').disabled = true; $('master-target-message').textContent = 'Saving…';
    try {
      await saveDashboardTarget(db, $('master-target-kg').value, session);
      $('master-target-message').textContent = 'Sales target saved.'; showToast('Sales target saved.');
      document.dispatchEvent(new CustomEvent('oms:dashboard-targetchange'));
    } catch (error) { $('master-target-message').textContent = friendlyError(error); }
    finally { $('master-target-save').disabled = false; }
  });
  $('master-add').addEventListener('click', () => openEditor());
  $('master-dialog-close').addEventListener('click', () => dialog.close());
  $('master-cancel').addEventListener('click', () => dialog.close());
  $('master-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const save = $('master-save'); save.disabled = true; save.textContent = 'Saving…';
    const form = event.currentTarget;
    const input = Object.fromEntries(new FormData(form));
    input.active = form.elements.namedItem('active').checked;
    if (type === 'users') input.operationId = userOperationId;
    try {
      await saveMasterRecord(db, type, editing?.id || null, input, session, functions);
      dialog.close(); showToast(`${MASTER_LABELS[type]} saved.`); await load();
    } catch (error) {
      $('master-form-error').textContent = friendlyError(error); $('master-form-error').hidden = false;
    } finally { saving = false; save.disabled = false; save.textContent = 'Save'; }
  });
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'master') load(); });

  return {
    setSession(user, profile) {
      session = user && isStaff(profile) ? { uid: user.uid, role: profile.role, profile } : null;
      if (!session) {
        ++loadRevision; records = []; dialog.close();
      } else if (!$('master-view').hidden) load();
    },
  };
}
