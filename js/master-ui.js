import { listMasterRecords, saveMasterRecord, deactivateMasterRecord, readDashboardTarget, saveDashboardTarget, readBusinessDetails, saveBusinessDetails } from './master-data.js';
import { MASTER_LABELS } from './master-validation.js';
import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { BUSINESS_DETAILS_ID } from './business-settings.js';
import { uniqueId } from './unique-id.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const PAGE_SIZE = 10;
const titles = { items: 'Items', purchaseTypes: 'Purchase Types', users: 'Users', settings: 'Settings' };
const subtitles = {
  items: 'Manage items and prices for KG, 500 GM and 250 GM.',
  purchaseTypes: 'Manage purchase categories.', users: 'Manage user accounts and roles through the trusted backend.',
  settings: 'Store non-secret application settings.',
};
const columns = {
  items: [['itemCode', 'Code'], ['name', 'Name'], ['defaultUnitId', 'Stock unit'], ['defaultSellingPrice', 'KG price'], ['sellingPrice500Gm', '500 GM price'], ['sellingPrice250Gm', '250 GM price']],
  purchaseTypes: [['name', 'Name'], ['description', 'Description']],
  users: [['displayName', 'Name'], ['role', 'Role'], ['email', 'Email']],
  settings: [['key', 'Key'], ['value', 'Value']],
};

function friendlyError(error) {
  if (error?.code === 'permission-denied') return 'Access denied. Check that your OMS profile is active and has the required role.';
  if (error?.code === 'unavailable') return 'The service is unavailable. Check your connection and try again.';
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
  const deactivating = new Set();
  const withLoader = (task, message) => globalThis.omsLoading?.withLoading ? globalThis.omsLoading.withLoading(task, message) : task();
  const dialog = $('master-dialog');

  function message(text, error = false) {
    $('master-message').textContent = text;
    $('master-message').classList.toggle('is-error', error);
    $('master-message').hidden = !text;
  }

  function recordName(record) { return record.name || record.displayName || record.fullName || record.key || record.itemCode || record.id || ''; }
  const canManageUser = (record) => type === 'users' && session && record.id !== session.uid && (session.role === 'admin' || session.role === 'account_admin' && record.role === 'user');
  async function sendSetup(record, button) {
    if (!canManageUser(record) || !record.active || !record.email || button.disabled) return;
    if (globalThis.confirm && !globalThis.confirm(`Send a password setup link to ${record.email}?`)) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Sending…';
    try {
      const result = await callOperation(functions, 'sendUserSetupLink', { targetUid: record.id });
      showToast(mode === 'emulator' ? `Setup request accepted for ${result.email}. Check the Auth emulator email action.` : `Firebase accepted the setup email request for ${result.email}.`);
    } catch (error) { message(`Setup link could not be sent: ${friendlyError(error)}`, true); }
    finally { button.disabled = false; button.textContent = original; }
  }

  function visibleRecords() {
    const status = $('master-status').value;
    const result = records.filter((record) => {
      return status === 'all' || (record.active === true ? 'active' : 'inactive') === status;
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
    $('master-mobile-list').innerHTML = shown.length ? shown.map((record) => {
      const name = recordName(record);
      const details = columns[type].slice(1, 3).map(([key]) => {
        let value = record[key] ?? (key === 'displayName' ? record.fullName : undefined);
        if (key === 'role') value = ({ admin: 'Admin', account_admin: 'Account Admin', user: 'User' })[value] || value;
        if (key === 'defaultUnitId') value = unitNames.get(value) || value;
        return value;
      }).filter((value) => value !== undefined && value !== '').join(' · ');
      const canEdit = type !== 'users' || canManageUser(record);
      return `<article class="mobile-record-card"><div class="mobile-record-top"><strong>${esc(name)}</strong><span class="master-status ${record.active ? 'is-active' : ''}">${record.active ? 'Active' : 'Inactive'}</span></div><p>${esc(details || '—')}</p>${canEdit ? `<div class="mobile-record-actions"><button type="button" data-master-action="edit" data-id="${esc(record.id)}">Edit</button>${canManageUser(record) && record.active && record.email ? `<button type="button" data-master-action="setup" data-id="${esc(record.id)}">✉ Send Setup Link</button>` : ''}${record.active ? `<button type="button" data-master-action="deactivate" data-id="${esc(record.id)}">Deactivate</button>` : type === 'users' ? `<button type="button" data-master-action="reactivate" data-id="${esc(record.id)}">Reactivate</button>` : ''}</div>` : ''}</article>`;
    }).join('') : `<p class="mobile-record-empty">${records.length ? 'No records match the current filters.' : `No ${titles[type].toLowerCase()} yet.`}</p>`;
    if (!shown.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = columns[type].length + 2; cell.className = 'empty-cell';
      cell.textContent = records.length ? 'No records match the current filter.' : `No ${titles[type].toLowerCase()} yet.`;
      row.append(cell); body.append(row);
    }
    for (const record of shown) {
      const row = document.createElement('tr');
      for (const [key] of columns[type]) {
        const cell = document.createElement('td');
        let value = record[key] ?? (key === 'displayName' ? record.fullName : undefined);
        if (['defaultSellingPrice', 'sellingPrice500Gm', 'sellingPrice250Gm'].includes(key) && value !== undefined) value = `₹${Number(value).toFixed(2)}`;
        if (key === 'defaultUnitId') value = String(record.name || '').trim().toLocaleLowerCase() === 'gift packing' ? 'Pieces (PCS)' : unitNames.get(value) || value || '—';
        if (key === 'role') value = ({ admin: 'Admin', account_admin: 'Account Admin', user: 'User' })[value] || value;
        cell.textContent = String(value ?? '—'); row.append(cell);
      }
      const status = document.createElement('td');
      const badge = document.createElement('span'); badge.className = `master-status ${record.active ? 'is-active' : ''}`;
      badge.textContent = record.active ? 'Active' : 'Inactive'; status.append(badge); row.append(status);
      const actions = document.createElement('td'); actions.className = 'master-actions';
      const canEdit = type !== 'users' || canManageUser(record);
      if (canEdit) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'text-button'; edit.textContent = 'Edit';
        edit.addEventListener('click', () => openEditor(record)); actions.append(edit);
        if (type === 'users' && record.email && record.active) {
          const setup = document.createElement('button'); setup.type = 'button'; setup.className = 'text-button'; setup.textContent = '✉ Send Setup Link';
          setup.addEventListener('click', () => sendSetup(record, setup)); actions.append(setup);
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

  let recordLoadToken = null;
  const stopRecordLoad = () => { if (recordLoadToken) globalThis.omsLoading?.stop(recordLoadToken); recordLoadToken = null; };
  async function load() {
    if (!session || !isStaff(session.profile)) return;
    const revision = ++loadRevision;
    message('');
    stopRecordLoad();
    recordLoadToken = globalThis.omsLoading?.start(`Loading ${titles[type].toLowerCase()}…`) || null;
    $('master-add').disabled = true;
    readDashboardTarget(db).then((value) => { if (revision === loadRevision) $('master-target-kg').value = value; }).catch((error) => { if (revision === loadRevision) $('master-target-message').textContent = friendlyError(error); });
    if (type === 'settings') readBusinessDetails(db).then((details) => {
      if (revision !== loadRevision) return;
      $('master-business-address').value = details.address;
      $('master-business-contact').value = details.contactNumber;
      $('master-business-fssai').value = details.fssaiLicenseNo;
      $('master-business-message').textContent = '';
    }).catch((error) => { if (revision === loadRevision) $('master-business-message').textContent = friendlyError(error); });
    try {
      const [result, units] = await Promise.all([listMasterRecords(db, type), type === 'items' ? listMasterRecords(db, 'units') : Promise.resolve([])]);
      if (revision !== loadRevision) return;
      records = type === 'settings' ? result.filter((entry) => entry.id !== BUSINESS_DETAILS_ID) : result;
      unitNames = new Map(units.map((unit) => [unit.id, `${unit.name} (${unit.symbol})`]));
      message(''); render();
    } catch (error) {
      if (revision !== loadRevision) return;
      records = []; render(); message(friendlyError(error), true);
    } finally {
      if (revision === loadRevision) {
        $('master-add').disabled = false;
        $('master-add').title = '';
        stopRecordLoad();
      }
    }
  }

  async function openEditor(record = null) {
    if (!session || !isStaff(session.profile) || saving) return;
    userOperationId = uniqueId();
    editing = record;
    $('master-dialog-title').textContent = `${record ? 'Edit' : 'Add'} ${MASTER_LABELS[type].toLowerCase()}`;
    $('master-dialog-hint').textContent = type === 'users'
      ? 'Set a password here, or leave it blank and send a password setup email after saving. Passwords are not stored in user profiles.'
      : type === 'items' && record ? 'Item codes stay fixed to protect references and uniqueness.'
        : type === 'settings' ? 'Use settings for non-secret values only.' : '';
    $('master-form-error').hidden = true;
    const fields = $('master-form-fields'); fields.replaceChildren();
    if (type === 'items') {
      fields.append(field('itemCode', 'Item code', { required: true, max: 32, value: record?.itemCode, readonly: !!record }));
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('description', 'Description', { type: 'textarea', max: 500, value: record?.description }));
      fields.append(field('defaultSellingPrice', 'Default selling price (₹)', { type: 'number', required: true, value: record?.defaultSellingPrice ?? 0 }));
      fields.append(field('sellingPrice500Gm', '500 GM selling price (₹)', { type: 'number', value: record?.sellingPrice500Gm ?? '' }));
      fields.append(field('sellingPrice250Gm', '250 GM selling price (₹)', { type: 'number', value: record?.sellingPrice250Gm ?? '' }));
      const stockUnit = document.createElement('input');
      stockUnit.type = 'hidden';
      stockUnit.name = 'defaultUnitId';
      stockUnit.value = record?.defaultUnitId || 'kg';
      fields.append(stockUnit);
    } else if (type === 'units') {
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('symbol', 'Symbol', { required: true, max: 16, value: record?.symbol }));
    } else if (type === 'purchaseTypes') {
      fields.append(field('name', 'Name', { required: true, value: record?.name }));
      fields.append(field('description', 'Description', { type: 'textarea', max: 500, value: record?.description }));
    } else if (type === 'users') {
      fields.append(field('email', 'Email', { type: 'email', required: true, max: 254, value: record?.email }));
      fields.append(field('fullName', 'Full name', { required: true, max: 80, value: record?.displayName || record?.fullName }));
      if (!record) fields.append(field('password', 'Password (optional)', { type: 'password', minLength: 8, max: 128, autocomplete: 'new-password' }));
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
    if (!session || !isStaff(session.profile) || deactivating.has(record.id)) return;
    if (!window.confirm(`Deactivate ${MASTER_LABELS[type].toLowerCase()} “${recordName(record)}”? Existing references will be kept.`)) return;
    deactivating.add(record.id);
    try {
      if (type === 'users' && !deactivationOperations.has(record.id)) deactivationOperations.set(record.id, uniqueId());
      await withLoader(() => deactivateMasterRecord(db, type, record.id, session, functions, deactivationOperations.get(record.id)), `Deactivating ${MASTER_LABELS[type].toLowerCase()}…`);
      deactivationOperations.delete(record.id);
      showToast(`${MASTER_LABELS[type]} deactivated.`);
      await load();
    } catch (error) { message(friendlyError(error), true); }
    finally { deactivating.delete(record.id); }
  }

  document.querySelectorAll('[data-master-tab]').forEach((button) => button.addEventListener('click', () => {
    type = button.dataset.masterTab; page = 1; $('master-status').value = 'all';
    $('master-business-form').hidden = type !== 'settings';
    const canSaveBusiness = session?.role === 'admin';
    for (const id of ['master-business-address', 'master-business-contact', 'master-business-fssai', 'master-business-save']) $(id).disabled = !canSaveBusiness;
    document.querySelectorAll('[data-master-tab]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('is-active', selected); tab.setAttribute('aria-selected', String(selected));
    });
    $('master-title').textContent = titles[type]; $('master-subtitle').textContent = subtitles[type];
    $('master-add').textContent = `Add ${MASTER_LABELS[type].toLowerCase()}`;
    load();
  }));
  $('master-status').addEventListener('change', () => { page = 1; render(); });
  $('master-sort').addEventListener('change', () => { page = 1; render(); });
  $('master-prev').addEventListener('click', () => { page--; render(); });
  $('master-next').addEventListener('click', () => { page++; render(); });
  $('master-refresh').addEventListener('click', load);
  $('master-target-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if ($('master-target-save').disabled) return; $('master-target-save').disabled = true; $('master-target-message').textContent = 'Saving…';
    try {
      await withLoader(() => saveDashboardTarget(db, $('master-target-kg').value, session), 'Saving sales target…');
      $('master-target-message').textContent = 'Sales target saved.'; showToast('Sales target saved.');
      document.dispatchEvent(new CustomEvent('oms:dashboard-targetchange'));
    } catch (error) { $('master-target-message').textContent = friendlyError(error); }
    finally { $('master-target-save').disabled = false; }
  });
  $('master-business-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('master-business-save').disabled) return;
    $('master-business-save').disabled = true;
    $('master-business-message').textContent = 'Saving…';
    try {
      await withLoader(() => saveBusinessDetails(db, { address: $('master-business-address').value, contactNumber: $('master-business-contact').value, fssaiLicenseNo: $('master-business-fssai').value }, session), 'Saving business details…');
      $('master-business-message').textContent = 'Business details saved.';
      showToast('Business details saved.');
      await load();
    } catch (error) { $('master-business-message').textContent = friendlyError(error); }
    finally { $('master-business-save').disabled = session?.role !== 'admin'; }
  });
  $('master-add').addEventListener('click', () => openEditor());
  $('master-mobile-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-master-action]'); if (!button) return;
    const record = records.find((entry) => entry.id === button.dataset.id); if (!record) return;
    if (button.dataset.masterAction === 'edit') openEditor(record);
    if (button.dataset.masterAction === 'deactivate') deactivateRecord(record);
    if (button.dataset.masterAction === 'setup') sendSetup(record, button);
    if (button.dataset.masterAction === 'reactivate') openEditor(record);
  });
  $('master-dialog-close').addEventListener('click', () => dialog.close());
  $('master-cancel').addEventListener('click', () => dialog.close());
  $('master-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const save = $('master-save'); save.disabled = true; save.textContent = 'Saving…';
    try {
      const form = event.currentTarget;
      const input = Object.fromEntries(new FormData(form));
      input.active = form.elements.namedItem('active').checked;
      if (type === 'users') input.operationId = userOperationId;
      await withLoader(() => saveMasterRecord(db, type, editing?.id || null, input, session, functions), `Saving ${MASTER_LABELS[type].toLowerCase()}…`);
      dialog.close(); showToast(`${MASTER_LABELS[type]} saved.`); await load();
    } catch (error) {
      $('master-form-error').textContent = friendlyError(error); $('master-form-error').hidden = false;
    } finally { saving = false; save.disabled = false; save.textContent = 'Save'; }
  });
  document.addEventListener('oms:pagechange', (event) => { if (event.detail.page === 'master') load(); else stopRecordLoad(); });

  return {
    setSession(user, profile) {
      session = user && isStaff(profile) ? { uid: user.uid, role: profile.role, profile } : null;
      if (!session) {
        stopRecordLoad();
        ++loadRevision; records = []; dialog.close();
      } else if (!$('master-view').hidden) load();
    },
  };
}
