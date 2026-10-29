import { isStaff } from './permissions.js';
import { BOX_UNITS, listBoxRequirements } from './box-req-data.js';

const $ = (id) => document.getElementById(id);

export function initBoxReq(services) {
  let profile = null, revision = 0, result = null, pending = null, loaderToken = null;
  const message = $('boxReq-message');
  const body = $('boxReq-body');
  const summary = $('boxReq-summary');
  const specials = $('boxReq-specials'), wrapping = $('boxReq-wrapping');
  const search = $('boxReq-search');
  const refreshButton = $('boxReq-refresh');

  const status = (value) => { message.textContent = value; };
  const stopLoader = () => {
    if (loaderToken) globalThis.omsLoading?.stop(loaderToken);
    loaderToken = null;
  };
  function render() {
    body.replaceChildren(); summary.replaceChildren(); specials.replaceChildren(); wrapping.replaceChildren();
    if (!result) return;
    const renderTable = (target, rows, emptyText, columnCount, withUnit) => {
      if (!rows?.length) {
        const row = document.createElement('tr'), cell = document.createElement('td');
        cell.colSpan = columnCount; cell.className = 'empty-cell'; cell.textContent = emptyText;
        row.append(cell); target.append(row); return;
      }
      for (const item of rows) {
        const row = document.createElement('tr'), name = document.createElement('th'), quantity = document.createElement('td');
        name.scope = 'row'; name.textContent = item.name;
        quantity.textContent = withUnit ? String(item.quantity) : `${item.quantity} PCS`;
        row.append(name, quantity);
        if (withUnit) { const unit = document.createElement('td'); unit.textContent = item.unit; row.append(unit); }
        target.append(row);
      }
    };
    renderTable(specials, result.specials, 'No special items required.', 2, false);
    renderTable(wrapping, result.wrapping, 'No gift wrapping required.', 3, true);
    for (const [id, label] of BOX_UNITS) {
      const tile = document.createElement('div'); tile.className = 'box-req-total';
      const caption = document.createElement('span'); caption.textContent = label;
      const count = document.createElement('strong'); count.textContent = String(result.totals[id]);
      const suffix = document.createElement('small'); suffix.textContent = 'boxes';
      tile.append(caption, count, suffix); summary.append(tile);
    }
    const rows = result.items.filter((item) => item.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    if (!rows.length) {
      const row = document.createElement('tr'), cell = document.createElement('td');
      cell.colSpan = 4; cell.className = 'empty-cell';
      cell.textContent = result.items.length ? 'No sweets match your search.' : 'No boxes required from qualifying orders.';
      row.append(cell); body.append(row); return;
    }
    for (const item of rows) {
      const row = document.createElement('tr'), name = document.createElement('th');
      name.scope = 'row'; name.textContent = item.name; row.append(name);
      for (const [id] of BOX_UNITS) {
        const cell = document.createElement('td'); cell.textContent = String(item.quantities[id]); row.append(cell);
      }
      body.append(row);
    }
  }

  function refresh() {
    if (!isStaff(profile)) return Promise.resolve();
    if (pending) {
      if (!loaderToken) loaderToken = globalThis.omsLoading?.start('Loading box requirements?') || null;
      return pending;
    }
    const current = ++revision;
    refreshButton.disabled = true;
    search.disabled = true;
    result = null; render(); status('');
    loaderToken = globalThis.omsLoading?.start('Loading box requirements�') || null;
    const request = (async () => {
      try {
        const next = await listBoxRequirements(services.db, profile);
        if (current !== revision) return;
        result = next; render(); status('');
      } catch (error) {
        if (current !== revision) return;
        result = null; render();
        status(error.code === 'permission-denied' ? 'Access denied to box requirements.' : `${error.message || 'Could not load box requirements.'} Try Refresh.`);
      } finally {
        if (current === revision) { refreshButton.disabled = false; search.disabled = false; stopLoader(); }
      }
    })();
    pending = request;
    request.finally(() => { if (pending === request) pending = null; });
    return request;
  }

  search.addEventListener('input', render);
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('oms:pagechange', (event) => {
    if (event.detail.page === 'boxReq' && !result) refresh();
    else if (event.detail.page !== 'boxReq') {
      stopLoader();
    }
  });
  return { setSession(user, nextProfile) {
    revision++; stopLoader(); pending = null; result = null;
    profile = isStaff(nextProfile) ? { ...nextProfile, uid: user?.uid } : null;
    search.value = ''; search.disabled = false; refreshButton.disabled = false;
    render(); status('');
  } };
}
