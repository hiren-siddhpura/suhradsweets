import { callOperation } from './operations-data.js';
import { analyticsColumns, analyticsCsv, matchingOrders, quantities, quantityText, sortAnalyticsRows, statusSortValue, totalText } from './order-analytics-data.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const statusName = (value) => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
const FILTER_IDS = ['analytics-search', 'analytics-user', 'analytics-status', 'analytics-from', 'analytics-to'];
const FETCH_TIMEOUT_MS = 20000;

export function initOrderAnalytics({ functions }) {
  let session = null, data = null, detailUid = '', loaded = false, fetching = false;
  let requestId = 0, filterRevision = 0, filterTimer = null, currentCsv = '';
  let detailHistoryEntry = false, summaryScrollLeft = 0, summaryScrollTop = 0, restoreSummaryScroll = false;
  const defaultSort = () => ({ summary: { key: 'user', direction: 'asc' }, detail: { key: 'customer', direction: 'asc' } });
  let sortState = defaultSort();

  const filters = () => ({
    search: $('analytics-search').value,
    user: data?.staff ? $('analytics-user').value : '',
    status: $('analytics-status').value,
    from: $('analytics-from').value,
    to: $('analytics-to').value,
  });
  const setViewState = (state, message = '') => {
    const showingTable = state === 'table';
    $('analytics-state').hidden = state === 'idle' || showingTable;
    $('analytics-loading').hidden = state !== 'loading';
    $('analytics-error').hidden = state !== 'error';
    $('analytics-table-wrap').hidden = !showingTable;
    $('analytics-export').disabled = !showingTable || !currentCsv;
    if (state === 'error') $('analytics-error-text').textContent = message;
  };
  const displayStatus = (order) => {
    const invoice = data.invoices.find((entry) => entry.orderId === order.id);
    if (!invoice) return statusName(order.status);
    const pending = (data.payments || []).some((entry) => entry.orderId === order.id && entry.verificationStatus === 'unverified' && !entry.reversed);
    const payment = invoice.paymentStatus === 'paid' || invoice.verifiedPaidPaise >= invoice.totalPaise && invoice.totalPaise > 0 ? 'Paid' : pending || invoice.paymentStatus === 'in_process' ? 'Payment in process' : invoice.paymentStatus === 'partial' || invoice.verifiedPaidPaise > 0 ? 'Partially paid' : 'Unpaid';
    return `${statusName(order.status)} · Invoiced · ${payment}`;
  };
  const updateDetailHeading = () => {
    const user = data?.users.find((entry) => entry.id === detailUid);
    if (detailUid && !user) detailUid = '';
    $('analytics-detail-header').hidden = !detailUid;
    $('analytics-detail-name').textContent = user?.name || '';
    $('analytics-user-wrap').hidden = !data?.staff || Boolean(detailUid);
    $('analytics-search').placeholder = detailUid ? 'Customer or order' : 'User, customer or order';
  };
  const renderTable = () => {
    if (!data || !session) return;
    updateDetailHeading();
    const cols = analyticsColumns(data);
    const scoped = data.staff ? data : { ...data, orders: data.orders.filter((order) => order.assignedUserId === session.uid) };
    const matched = matchingOrders(scoped, filters());
    const orders = detailUid ? matched.filter((order) => order.assignedUserId === detailUid) : matched;
    const columnDefs = detailUid
      ? [{ key: 'customer', label: 'Customer Name' }, { key: 'phone', label: 'Phone' }, { key: 'area', label: 'Area' }, { key: 'orderNumber', label: 'Order No.' }, { key: 'orderDate', label: 'Order Date' }, ...cols.map((col) => ({ key: `product:${col.key}`, label: `${col.name} (${col.unit})` })), { key: 'status', label: 'Status' }, { key: 'total', label: 'Total' }]
      : [{ key: 'user', label: 'User' }, ...cols.map((col) => ({ key: `product:${col.key}`, label: `${col.name} (${col.unit})` })), { key: 'total', label: 'Total Quantity' }];
    const headers = columnDefs.map((col) => col.label);
    const view = detailUid ? 'detail' : 'summary';
    if (!columnDefs.some((col) => col.key === sortState[view].key)) sortState[view] = defaultSort()[view];
    const activeSort = sortState[view];
    $('analytics-head').innerHTML = `<tr>${columnDefs.map((col) => {
      const active = col.key === activeSort.key;
      const direction = active ? activeSort.direction : '';
      const hint = col.key === 'status' ? ' title="Status order: Draft, Confirmed, In preparation, Ready, Delivered. Payment order: Unpaid, Payment in process, Partially paid, Paid."' : col.key === 'total' ? ' title="Sort total by KG, then PCS"' : '';
      return `<th scope="col" aria-sort="${active ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}" class="${active ? 'is-sorted' : ''}"><button type="button" class="analytics-sort-button" data-sort-key="${esc(col.key)}" aria-label="Sort by ${esc(col.label)}${active ? `, currently ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}"${hint}><span>${esc(col.label)}</span><span class="analytics-sort-icon" aria-hidden="true">${active ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>`;
    }).join('')}</tr>`;
    const rows = [];
    if (detailUid) {
      for (const order of orders) {
        const customer = data.customers.find((entry) => entry.id === order.customerId);
        const values = quantities([order], cols);
        const name = customer?.name || order.customerName || 'Unavailable', phone = customer?.phone || '', area = customer?.area || '', status = displayStatus(order);
        rows.push({ id: order.id, cells: [name, phone, area, order.orderNumber, order.orderDate, ...cols.map((col) => quantityText(values[col.key], col.unit)), status, totalText(values, cols)], sortValues: { customer: name, phone, area, orderNumber: order.orderNumber, orderDate: order.orderDate, status: statusSortValue(order.status, status), total: [cols.filter((col) => col.unit === 'KG').reduce((sum, col) => sum + values[col.key], 0), cols.filter((col) => col.unit === 'PCS').reduce((sum, col) => sum + values[col.key], 0)], ...Object.fromEntries(cols.map((col) => [`product:${col.key}`, values[col.key]])) } });
      }
    } else {
      const selection = filters();
      for (const user of data.users.filter((entry) => (data.staff || entry.id === session.uid) && (!selection.user || entry.id === selection.user))) {
        const userOrders = orders.filter((order) => order.assignedUserId === user.id);
        if (!orders.length) continue;
        if ((selection.search || selection.from || selection.to || selection.status || selection.user) && !userOrders.length) continue;
        const values = quantities(userOrders, cols);
        rows.push({ id: user.id, cells: [user.name, ...cols.map((col) => quantityText(values[col.key], col.unit)), totalText(values, cols)], sortValues: { user: user.name, total: [cols.filter((col) => col.unit === 'KG').reduce((sum, col) => sum + values[col.key], 0), cols.filter((col) => col.unit === 'PCS').reduce((sum, col) => sum + values[col.key], 0)], ...Object.fromEntries(cols.map((col) => [`product:${col.key}`, values[col.key]])) } });
      }
    }
    const sortedRows = sortAnalyticsRows(rows, activeSort);
    $('analytics-body').innerHTML = sortedRows.length ? sortedRows.map((row) => `<tr data-analytics-row="${esc(row.id)}">${row.cells.map((value, index) => `<td>${index === 0 && !detailUid ? `<button type="button" data-analytics-user="${esc(row.id)}" aria-label="View ${esc(value)} customer orders">${esc(value)}</button>` : esc(value)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">No orders match these filters.</td></tr>`;
    const totals = quantities(orders, cols);
    const footer = detailUid ? ['Total', '', '', '', '', ...cols.map((col) => quantityText(totals[col.key], col.unit)), '', totalText(totals, cols)] : ['Total', ...cols.map((col) => quantityText(totals[col.key], col.unit)), totalText(totals, cols)];
    $('analytics-foot').innerHTML = `<tr>${footer.map((value) => `<th>${esc(value)}</th>`).join('')}</tr>`;
    $('analytics-message').textContent = `${rows.length} ${detailUid ? 'orders' : 'users'} shown`;
    currentCsv = analyticsCsv(headers, sortedRows.map((row) => row.cells), footer);
    setViewState('table');
    if (restoreSummaryScroll && !detailUid) {
      restoreSummaryScroll = false;
      requestAnimationFrame(() => { $('analytics-table-wrap').scrollLeft = summaryScrollLeft; $('analytics-table-wrap').scrollTop = summaryScrollTop; });
    }
  };
  const scheduleRender = (delay = 90) => {
    if (!data || fetching) return;
    const revision = ++filterRevision;
    if (filterTimer) clearTimeout(filterTimer);
    currentCsv = '';
    $('analytics-message').textContent = '';
    setViewState('loading');
    filterTimer = setTimeout(() => {
      filterTimer = null;
      if (revision !== filterRevision || !session) return;
      try { renderTable(); }
      catch (error) {
        console.warn('[OMS analytics]', { category: 'filter-render', code: String(error?.code || 'unknown') });
        setViewState('error', 'Analytics could not be displayed. Try Refresh.');
      }
    }, delay);
  };
  async function refresh() {
    if (!session || fetching) return;
    fetching = true;
    const revision = ++requestId;
    ++filterRevision;
    if (filterTimer) { clearTimeout(filterTimer); filterTimer = null; }
    currentCsv = '';
    $('analytics-message').textContent = '';
    $('analytics-refresh').disabled = true;
    setViewState('loading');
    let timeout;
    try {
      const result = await Promise.race([
        callOperation(functions, 'getOrderAnalytics', {}),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), FETCH_TIMEOUT_MS); }),
      ]);
      if (revision !== requestId || !session) return;
      if (result.viewerUid !== session.uid) throw Object.assign(new Error('viewer-mismatch'), { code: 'viewer-mismatch' });
      data = result;
      loaded = true;
      const previousUser = $('analytics-user').value;
      $('analytics-user').innerHTML = `<option value="">All users</option>${result.staff ? result.users.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.name)}</option>`).join('') : ''}`;
      $('analytics-user').value = result.staff && result.users.some((entry) => entry.id === previousUser) ? previousUser : '';
      renderTable();
    } catch (error) {
      if (revision !== requestId) return;
      console.warn('[OMS analytics]', { category: 'load-failed', code: String(error?.code || 'unknown') });
      data = null;
      loaded = false;
      $('analytics-message').textContent = '';
      setViewState('error', error?.code === 'timeout' ? 'Analytics is taking too long to load. Check your connection and retry.' : error?.code === 'permission-denied' ? 'Your account cannot access Order Analytics. Contact an administrator if this seems incorrect.' : 'Analytics could not be loaded. Check your connection and retry.');
    } finally {
      clearTimeout(timeout);
      if (revision === requestId) { fetching = false; $('analytics-refresh').disabled = false; }
    }
  }
  for (const id of FILTER_IDS) $(id).addEventListener(id === 'analytics-search' ? 'input' : 'change', () => scheduleRender(id === 'analytics-search' ? 180 : 90));
  $('analytics-clear').addEventListener('click', () => { for (const id of FILTER_IDS) $(id).value = ''; scheduleRender(0); });
  $('analytics-refresh').addEventListener('click', refresh);
  $('analytics-retry').addEventListener('click', refresh);
  $('analytics-export').addEventListener('click', () => {
    if (!currentCsv || !data || !session) return;
    const blob = new Blob([currentCsv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url;
    link.download = detailUid ? 'order-analytics-detail.csv' : 'order-analytics-summary.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('analytics-head').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-sort-key]');
    if (!button || !data || !session) return;
    const view = detailUid ? 'detail' : 'summary';
    const key = button.dataset.sortKey;
    if (!key || ![...((detailUid ? ['customer', 'phone', 'area', 'orderNumber', 'orderDate', 'status', 'total'] : ['user', 'total'])), ...analyticsColumns(data).map((col) => `product:${col.key}`)].includes(key)) return;
    sortState[view] = { key, direction: sortState[view].key === key && sortState[view].direction === 'asc' ? 'desc' : 'asc' };
    renderTable();
  });
  $('analytics-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-analytics-user]');
    if (!button || !data?.users.some((entry) => entry.id === button.dataset.analyticsUser) || !data.staff && button.dataset.analyticsUser !== session?.uid) return;
    summaryScrollLeft = $('analytics-table-wrap').scrollLeft;
    summaryScrollTop = $('analytics-table-wrap').scrollTop;
    detailUid = button.dataset.analyticsUser;
    detailHistoryEntry = true;
    history.pushState({ ...history.state, omsAnalyticsDetail: detailUid }, '', window.location.href);
    updateDetailHeading();
    scheduleRender(0);
  });
  $('analytics-back').addEventListener('click', () => {
    if (detailHistoryEntry) history.back();
    else { detailUid = ''; restoreSummaryScroll = true; updateDetailHeading(); scheduleRender(0); }
  });
  window.addEventListener('popstate', (event) => {
    if (!session || !detailUid && !event.state?.omsAnalyticsDetail) return;
    const candidate = event.state?.omsAnalyticsDetail || '';
    detailUid = data?.users.some((entry) => entry.id === candidate) && (data.staff || candidate === session.uid) ? candidate : '';
    detailHistoryEntry = Boolean(detailUid);
    restoreSummaryScroll = !detailUid;
    updateDetailHeading();
    scheduleRender(0);
  });
  document.querySelector('[data-page="orderAnalytics"]').addEventListener('click', () => { if (session && !loaded && !fetching) refresh(); });
  return {
    setSession(user, profile) {
      ++requestId;
      ++filterRevision;
      if (filterTimer) { clearTimeout(filterTimer); filterTimer = null; }
      session = user && profile?.active ? { uid: user.uid } : null;
      data = null; detailUid = ''; loaded = false; fetching = false; currentCsv = ''; detailHistoryEntry = false; sortState = defaultSort();
      for (const id of FILTER_IDS) $(id).value = '';
      $('analytics-head').innerHTML = '';
      $('analytics-body').innerHTML = '';
      $('analytics-foot').innerHTML = '';
      $('analytics-message').textContent = '';
      $('analytics-refresh').disabled = false;
      updateDetailHeading();
      setViewState('idle');
      const nav = document.querySelector('[data-page="orderAnalytics"]');
      if (session && !nav.hidden && nav.classList.contains('is-active')) refresh();
    },
  };
}
