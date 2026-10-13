import { isStaff } from './permissions.js';
import { showToast } from './ui.js';
import { callOperation } from './operations-data.js';
import { activeAnnouncements, allReportRows, dashboardOrderKg, dashboardStockKg, dashboardTargetKg, recentActivity, reportPage, reportUsers, targetAchievement } from './reporting-data.js';
import { targetPercentage } from './dashboard-metrics.js';
import { downloadXlsx } from './xlsx-export.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const localDate = (stamp) => stamp?.toDate?.()?.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) || '';
const currentDay = () => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
const today = () => { const parts = currentDay(); return `${parts.year}-${parts.month}-${parts.day}`; };
const issue = (error) => {
  const code = String(error?.code || '').replace(/^firestore\//, '');
  if (code === 'failed-precondition' && /index/i.test(error?.message || '')) return 'A required Firestore index is missing or still building.';
  if (code === 'permission-denied') return 'Your account does not have permission to read this data.';
  if (['unavailable', 'deadline-exceeded'].includes(code)) return 'Could not reach Firestore. Check your connection and retry.';
  return 'Could not load this data. Please retry.';
};
const card = (label, value) => `<div class="card ops-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
const empty = (count, text) => `<tr><td colspan="${count}" class="empty-cell">${esc(text)}</td></tr>`;
const textField = (label, name, value = '', extra = '') => `<label class="ops-field">${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const detailText = (detail) => Object.entries(detail || {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('; ');

export function initReportingUi({ db, functions }) {
  let user = null, profile = null, users = [], revision = 0, dashboardRun = 0, dialogKind = '', editing = null;
  const state = Object.fromEntries(['target', 'announcement', 'login', 'audit'].map((name) => [name, { page: 1, cursors: [null], rows: [], hasMore: false, busy: false }]));
  const staff = () => isStaff(profile);
  const userName = (uid) => { const entry = users.find((item) => item.id === uid); return entry?.displayName || entry?.fullName || (uid === user?.uid ? profile?.displayName || profile?.fullName : '') || uid || '—'; };
  const mapping = { target: 'targets', announcement: 'announcements', login: 'loginLogs', audit: 'auditLogs' };
  const filters = (kind) => ({
    userId: kind === 'target' ? $('target-user').value : kind === 'login' || kind === 'audit' ? $(`${kind}-user`).value.trim() : '',
    periodType: kind === 'target' ? $('target-period').value : '',
    status: $(`${kind}-status`).value.trim(),
    audience: kind === 'announcement' ? $('announcement-audience').value : '',
    entityId: kind === 'audit' ? $('audit-entity').value.trim() : '',
    search: kind === 'announcement' ? $('announcement-search').value.trim().toLowerCase() : '',
    from: $(`${kind}-from`).value, to: $(`${kind}-to`).value, sort: $(`${kind}-sort`).value,
  });
  const ownUid = (kind) => kind === 'target' && !staff() ? user.uid : null;

  async function load(kind, reset = false) {
    if (!profile || (kind !== 'target' && !staff())) return;
    const version = revision, cursorState = state[kind];
    if (reset) { cursorState.page = 1; cursorState.cursors = [null]; }
    cursorState.busy = true; $(`${kind}-message`).textContent = 'Loading records…';
    try {
      const page = await reportPage(db, mapping[kind], filters(kind), ownUid(kind), cursorState.cursors[cursorState.page - 1], kind === 'target' ? 10 : 20);
      if (version !== revision) return;
      cursorState.rows = page.rows; cursorState.hasMore = page.hasMore; cursorState.nextCursor = page.cursor;
      await render(kind, page.rows, version);
      $(`${kind}-message`).textContent = '';
    } catch (error) { if (version === revision) { cursorState.rows = []; $(`${kind}-message`).textContent = issue(error); await render(kind, [], version); } }
    finally { cursorState.busy = false; }
  }

  async function render(kind, rows, version) {
    const cursorState = state[kind];
    $(`${kind}-page`).textContent = `Page ${cursorState.page}${cursorState.hasMore ? ' · more available' : ''}`;
    $(`${kind}-prev`).disabled = cursorState.page === 1; $(`${kind}-next`).disabled = !cursorState.hasMore;
    if (kind === 'target') {
      const achieved = await Promise.all(rows.map((entry) => targetAchievement(db, entry).catch(() => null)));
      if (version !== revision) return;
      $('target-cards').innerHTML = card('Targets on page', rows.length) + card('Active on page', rows.filter((entry) => entry.active).length) + card('Target value on page', money(rows.reduce((sum, entry) => sum + Number(entry.targetPaise || 0), 0)));
      $('target-body').innerHTML = rows.length ? rows.map((entry, index) => `<tr><td>${esc(userName(entry.ownerUid))}</td><td>${esc(entry.periodType)}</td><td>${esc(entry.periodStart)} to ${esc(entry.periodEnd)}</td><td>${esc(money(entry.targetPaise))}</td><td>${achieved[index] === null ? 'Unavailable' : esc(money(achieved[index]))}</td><td>${entry.targetPaise === 0 ? 'N/A' : achieved[index] === null ? 'Unavailable' : `${esc(((achieved[index] / entry.targetPaise) * 100).toFixed(1))}%`}</td><td>${entry.active ? 'Active' : 'Inactive'}</td><td class="ops-actions">${staff() ? `<button data-report="edit" data-kind="target" data-id="${esc(entry.id)}">Edit</button>${entry.active ? `<button data-report="deactivate" data-kind="target" data-id="${esc(entry.id)}">Deactivate</button>` : ''}` : ''}</td></tr>`).join('') : empty(8, 'No targets match these filters.');
    } else if (kind === 'announcement') {
      const day = today();
      $('announcement-cards').innerHTML = card('Announcements on page', rows.length) + card('Currently visible', rows.filter((entry) => entry.active && entry.startsOn <= day && entry.expiresOn >= day).length) + card('Expired on page', rows.filter((entry) => entry.expiresOn < day).length);
      $('announcement-body').innerHTML = rows.length ? rows.map((entry) => `<tr><td>${esc(entry.title)}<small>${esc(entry.body)}</small></td><td>${esc(entry.audience)}</td><td>${esc(entry.startsOn)}</td><td>${esc(entry.expiresOn)}</td><td>${entry.active ? entry.expiresOn < day ? 'Expired' : entry.startsOn > day ? 'Scheduled' : 'Active' : 'Inactive'}</td><td class="ops-actions"><button data-report="edit" data-kind="announcement" data-id="${esc(entry.id)}">Edit</button>${entry.active ? `<button data-report="deactivate" data-kind="announcement" data-id="${esc(entry.id)}">Deactivate</button>` : ''}</td></tr>`).join('') : empty(6, 'No announcements match these filters.');
    } else if (kind === 'login') {
      $('login-cards').innerHTML = card('Events on page', rows.length) + card('Logins on page', rows.filter((entry) => entry.type === 'login').length) + card('Logouts on page', rows.filter((entry) => entry.type === 'logout').length);
      $('login-body').innerHTML = rows.length ? rows.map((entry) => `<tr><td>${esc(localDate(entry.at))}</td><td>${esc(entry.type)}</td><td>${esc(userName(entry.uid))}<small>${esc(entry.uid)}</small></td></tr>`).join('') : empty(3, 'No login events match these filters.');
    } else {
      $('audit-cards').innerHTML = card('Actions on page', rows.length) + card('Actors on page', new Set(rows.map((entry) => entry.actorUid)).size) + card('Entities on page', new Set(rows.map((entry) => entry.referenceId)).size);
      $('audit-body').innerHTML = rows.length ? rows.map((entry) => `<tr><td>${esc(localDate(entry.at))}</td><td>${esc(entry.type)}</td><td>${esc(userName(entry.actorUid))}<small>${esc(entry.actorUid)}</small></td><td>${esc(entry.referenceType)} / ${esc(entry.referenceId)}</td><td>${esc(detailText(entry.detail))}</td></tr>`).join('') : empty(5, 'No audit events match these filters.');
    }
  }

  async function dashboard() {
    if (!profile) return;
    const version = revision, run = ++dashboardRun, day = today();
    const userOnly = profile.role === 'user';
    $('dashboard-announcements-panel').hidden = userOnly;
    $('dashboard-activity-panel').hidden = userOnly;
    if (userOnly) {
      $('dashboard-cards').innerHTML = '<div class="card stat-card dashboard-metric"><span class="stat-label">Total Orders</span><strong>Loading…</strong></div>';
      try {
        const orders = await dashboardOrderKg(db, profile.role, user.uid);
        if (version !== revision || run !== dashboardRun) return;
        $('dashboard-cards').innerHTML = `<div class="card stat-card dashboard-metric"><span class="stat-label">Total Orders</span><strong>${esc(orders.orderCount)} <span class="metric-unit">Orders</span></strong><small>Your orders</small></div>`;
      } catch (error) {
        if (version !== revision || run !== dashboardRun) return;
        $('dashboard-cards').innerHTML = '<div class="card stat-card dashboard-metric"><span class="stat-label">Total Orders</span><strong>Unavailable</strong><small>Your orders</small></div>';
        console.warn('[OMS dashboard]', { code: String(error?.code || 'unknown'), category: 'query-failed' });
      }
      return;
    }
    const labels = ['Total Orders', 'Target Achievement', 'Available Stock', 'Total Selling'];
    const icons = ['◫', '%', '◇', '▤'];
    const kg = (amount) => Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 3 });
    const dashboardCard = (label, content, index, hint = '') => `<div class="card stat-card dashboard-metric"><span class="stat-icon" aria-hidden="true">${icons[index]}</span><span class="stat-label">${esc(label)}</span>${content}<small>${esc(hint)}</small></div>`;
    const itemList = (items) => `<ul class="dashboard-item-list">${items.map((item) => `<li><span>${esc(item.name)}${item.blocked ? ' (blocked)' : ''}</span><b>${esc(kg(item.kg))} KG</b></li>`).join('')}</ul>`;
    $('dashboard-cards').innerHTML = labels.map((label, index) => dashboardCard(label, '<strong>…</strong>', index, 'Loading')).join('');
    $('dashboard-activity').innerHTML = empty(4, 'Loading recent activity…');
    $('dashboard-announcements').textContent = 'Loading announcements…';
    try {
      const results = await Promise.allSettled([
        dashboardOrderKg(db, profile.role, user.uid), dashboardTargetKg(db),
        dashboardStockKg(db, profile.role), recentActivity(db, profile.role, user.uid), activeAnnouncements(db, profile.role, day),
      ]);
      if (version !== revision || run !== dashboardRun) return;
      const errors = [];
      const value = (result, fallback = null) => { if (result.status === 'fulfilled') return result.value; errors.push(result.reason); return fallback; };
      const orders = value(results[0]), targetKg = value(results[1]), stock = value(results[2]), activity = value(results[3]), announcements = value(results[4]);
      const percent = orders && targetKg !== null ? targetPercentage(orders.totalKg, targetKg) : null;
      const targetFailed = results[1].status === 'rejected';
      const range = staff() ? 'All orders' : 'Your orders';
      const content = [
        orders ? `<strong>${esc(orders.orderCount)} <span class="metric-unit">Orders</span></strong><strong>${esc(kg(orders.totalKg))} <span class="metric-unit">KG</span></strong>` : '<strong>Unavailable</strong>',
        `<strong>${orders === null || targetFailed ? 'Unavailable' : percent === null ? 'N/A' : `${esc(percent.toFixed(1))} %`}</strong>`,
        stock ? `<strong>Total ${esc(kg(stock.totalKg))} <span class="metric-unit">KG</span></strong>${itemList(stock.items)}` : '<strong>Unavailable</strong>',
        orders ? `<strong>Total ${esc(kg(orders.totalKg))} <span class="metric-unit">KG</span></strong>${itemList(orders.items)}` : '<strong>Unavailable</strong>',
      ];
      const hints = [range, targetFailed ? 'Could not read the configured sales target.' : targetKg === null ? 'Set Sales target (KG) in Master Data.' : `Target: ${kg(targetKg)} KG · ${range}`, 'Current stock available for selling', range];
      if (orders?.excludedQuantities) hints[3] += ' · Non-weight or invalid units excluded from KG totals.';
      if (stock?.excludedQuantities) hints[2] += ' · Non-weight or invalid records excluded from KG totals.';
      $('dashboard-cards').innerHTML = labels.map((label, index) => dashboardCard(label, content[index], index, hints[index])).join('');
      $('dashboard-activity').innerHTML = activity === null ? empty(4, 'Recent activity is temporarily unavailable.') : activity.length ? activity.map((entry) => `<tr><td>${esc(localDate(entry.at))}</td><td>${esc(entry.type)}</td><td>${esc(userName(entry.actorUid))}</td><td>${esc(entry.referenceType)} / ${esc(entry.referenceId)}</td></tr>`).join('') : empty(4, 'No recent activity.');
      $('dashboard-announcements').innerHTML = announcements === null ? '<p>Announcements are temporarily unavailable.</p>' : announcements.length ? announcements.map((entry) => `<div class="report-announcement"><strong>${esc(entry.title)}</strong><p>${esc(entry.body)}</p><small>Until ${esc(entry.expiresOn)}</small></div>`).join('') : '<p>No active announcements.</p>';
      for (const error of errors) {
        console.warn('[OMS dashboard]', { code: String(error?.code || 'unknown'), category: /index/i.test(error?.message || '') ? 'missing-index' : 'query-failed' });
      }
    } catch (error) { console.warn('[OMS dashboard]', { code: String(error?.code || 'unknown'), category: 'dashboard-load-failed' }); }
  }

  function openDialog(kind, record = null) {
    if (!staff()) return;
    dialogKind = kind; editing = record; $('report-error').hidden = true;
    $('report-dialog-title').textContent = kind === 'target' ? record ? 'Edit target' : 'Set target' : record ? 'Edit announcement' : 'New announcement';
    if (kind === 'target') {
      $('report-fields').innerHTML = `<label class="ops-field">User<select name="ownerUid" required ${record ? 'disabled' : ''}>${users.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === record?.ownerUid ? 'selected' : ''}>${esc(entry.displayName || entry.fullName || entry.id)}</option>`).join('')}</select></label><label class="ops-field">Period<select name="periodType" ${record ? 'disabled' : ''}><option value="daily" ${record?.periodType === 'daily' ? 'selected' : ''}>Daily</option><option value="weekly" ${record?.periodType === 'weekly' ? 'selected' : ''}>Weekly</option><option value="monthly" ${record?.periodType === 'monthly' ? 'selected' : ''}>Monthly</option></select></label>${textField('Start date', 'periodStart', record?.periodStart || today(), `type="date" required ${record ? 'readonly' : ''}`)}${textField('Target (₹)', 'target', record ? (record.targetPaise / 100).toFixed(2) : '', 'type="number" min="0" step="0.01" required')}<label class="ops-field">Status<select name="active"><option value="true" ${record?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${record?.active === false ? 'selected' : ''}>Inactive</option></select></label>`;
    } else {
      $('report-fields').innerHTML = `${textField('Title', 'title', record?.title, 'required maxlength="120"')}<label class="ops-field">Message<textarea name="body" maxlength="1000" required>${esc(record?.body)}</textarea></label><label class="ops-field">Audience<select name="audience"><option value="all" ${record?.audience === 'all' ? 'selected' : ''}>Everyone</option><option value="staff" ${record?.audience === 'staff' ? 'selected' : ''}>Staff</option><option value="users" ${record?.audience === 'users' ? 'selected' : ''}>Users</option></select></label>${textField('Start date', 'startsOn', record?.startsOn || today(), 'type="date" required')}${textField('Expiry date', 'expiresOn', record?.expiresOn || today(), 'type="date" required')}<label class="ops-field">Status<select name="active"><option value="true" ${record?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${record?.active === false ? 'selected' : ''}>Inactive</option></select></label>`;
    }
    $('report-dialog').showModal();
  }

  async function exportReport(kind) {
    if (!profile || kind !== 'target' && !staff()) return;
    $(`${kind}-message`).textContent = 'Preparing authorized, filtered export…';
    try {
      const rows = await allReportRows(db, mapping[kind], filters(kind), ownUid(kind));
      const data = kind === 'target' ? await Promise.all(rows.map(async (entry) => { const achieved = await targetAchievement(db, entry); return { User: userName(entry.ownerUid), 'User UID': entry.ownerUid, Period: entry.periodType, 'Start date': entry.periodStart, 'End date': entry.periodEnd, 'Target (INR)': entry.targetPaise / 100, 'Eligible sales (INR)': achieved / 100, 'Achievement (%)': entry.targetPaise === 0 ? 'N/A' : Number((achieved / entry.targetPaise * 100).toFixed(1)), Status: entry.active ? 'Active' : 'Inactive' }; }))
        : kind === 'announcement' ? rows.map((entry) => ({ Title: entry.title, Message: entry.body, Audience: entry.audience, 'Start date': entry.startsOn, 'Expiry date': entry.expiresOn, Status: entry.active ? 'Active' : 'Inactive' }))
          : kind === 'login' ? rows.map((entry) => ({ 'Date and time': localDate(entry.at), Event: entry.type, User: userName(entry.uid), 'User UID': entry.uid }))
            : rows.map((entry) => ({ 'Date and time': localDate(entry.at), Action: entry.type, Actor: userName(entry.actorUid), 'Actor UID': entry.actorUid, 'Entity type': entry.referenceType, 'Entity ID': entry.referenceId, Details: detailText(entry.detail) }));
      await downloadXlsx(kind, [[kind, data]]); $(`${kind}-message`).textContent = '';
    } catch (error) { $(`${kind}-message`).textContent = `Export failed: ${issue(error)}`; }
  }

  for (const kind of Object.keys(state)) {
    const ids = kind === 'target' ? ['user', 'period', 'status', 'from', 'to', 'sort'] : kind === 'announcement' ? ['search', 'status', 'audience', 'from', 'to', 'sort'] : kind === 'login' ? ['user', 'status', 'from', 'to', 'sort'] : ['user', 'status', 'entity', 'from', 'to', 'sort'];
    let timer;
    for (const id of ids) $(`${kind}-${id}`).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(kind, true), 350); });
    $(`${kind}-prev`).onclick = () => { if (state[kind].page > 1 && !state[kind].busy) { state[kind].page--; load(kind); } };
    $(`${kind}-next`).onclick = () => { if (state[kind].hasMore && !state[kind].busy) { state[kind].cursors.push(state[kind].nextCursor); state[kind].page++; load(kind); } };
    $(`${kind}-export`).onclick = () => exportReport(kind);
  }
  $('target-new').onclick = () => openDialog('target'); $('announcement-new').onclick = () => openDialog('announcement');
  $('target-users').onclick = () => { document.querySelector('[data-page="master"]')?.click(); document.querySelector('[data-master-tab="users"]')?.click(); };
  $('dashboard-refresh').onclick = dashboard;
  document.addEventListener('oms:dashboard-targetchange', () => { if (!document.getElementById('dashboard-view').hidden) dashboard(); });
  $('report-dialog-close').onclick = $('report-cancel').onclick = () => $('report-dialog').close();
  for (const kind of ['target', 'announcement']) $(`${kind}-body`).addEventListener('click', async (event) => {
    const button = event.target.closest('[data-report]'); if (!button || !staff()) return;
    const record = state[kind].rows.find((entry) => entry.id === button.dataset.id); if (!record) return;
    if (button.dataset.report === 'edit') { openDialog(kind, record); return; }
    try {
      if (kind === 'target') await callOperation(functions, 'saveTarget', { ownerUid: record.ownerUid, periodType: record.periodType, periodStart: record.periodStart, targetPaise: record.targetPaise, active: false });
      else await callOperation(functions, 'saveAnnouncement', { announcementId: record.id, title: record.title, body: record.body, audience: record.audience, startsOn: record.startsOn, expiresOn: record.expiresOn, active: false });
      showToast('Record deactivated.'); await load(kind);
    } catch (error) { showToast(issue(error), 'toast-error'); }
  });
  $('report-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('report-save').disabled = true; $('report-error').hidden = true;
    try {
      const values = new FormData(event.currentTarget);
      if (dialogKind === 'target') {
        const amount = Number(values.get('target')); if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('Enter a nonnegative target with at most two decimal places.');
        await callOperation(functions, 'saveTarget', { ownerUid: editing?.ownerUid || values.get('ownerUid'), periodType: editing?.periodType || values.get('periodType'), periodStart: editing?.periodStart || values.get('periodStart'), targetPaise: Math.round(amount * 100), active: values.get('active') === 'true' });
      } else await callOperation(functions, 'saveAnnouncement', { announcementId: editing?.id, title: values.get('title'), body: values.get('body'), audience: values.get('audience'), startsOn: values.get('startsOn'), expiresOn: values.get('expiresOn'), active: values.get('active') === 'true' });
      $('report-dialog').close(); showToast('Record saved.'); await load(dialogKind); if (dialogKind === 'target') dashboard();
    } catch (error) { $('report-error').textContent = issue(error); $('report-error').hidden = false; }
    finally { $('report-save').disabled = false; }
  });
  document.addEventListener('oms:pagechange', (event) => {
    if (!profile) return;
    if (event.detail.page === 'dashboard') dashboard();
    const kind = Object.keys(mapping).find((key) => mapping[key] === event.detail.page);
    if (kind) load(kind, true);
  });
  return { async setSession(nextUser, nextProfile) {
    revision++; user = nextUser; profile = nextProfile; users = [];
    $('target-new').hidden = !staff(); $('target-users').hidden = !staff(); $('announcement-new').hidden = !staff(); $('target-user').hidden = !staff();
    if (!user || !profile) { $('dashboard-cards').innerHTML = ''; return; }
    const version = revision;
    if (staff()) {
      try {
        users = await reportUsers(db); if (version !== revision) return;
        const options = users.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.displayName || entry.fullName || entry.id)}</option>`).join('');
        $('target-user').innerHTML = `<option value="">All users</option>${options}`;
      } catch (error) { if (version === revision) showToast(`User list unavailable: ${issue(error)}`, 'toast-error'); }
    }
    if (document.querySelector('[data-page].is-active')?.dataset.page === 'dashboard') dashboard();
  } };
}
