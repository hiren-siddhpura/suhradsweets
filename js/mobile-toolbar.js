// Mobile presentation for existing filters. Controls retain their original nodes and listeners.
const mobile = () => matchMedia('(max-width: 760px)').matches;
const control = (node) => node?.matches?.('input,select,textarea') ? node : node?.querySelector?.('input,select,textarea');
const labelText = (node) => node.getAttribute?.('aria-label') || node.labels?.[0]?.textContent?.trim() || node.querySelector?.('.order-filter-label')?.textContent || node.querySelector?.('input,select')?.getAttribute('aria-label') || (node.matches?.('label') ? [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent.trim()).join(' ') : '') || node.querySelector?.('input,select')?.placeholder || node.getAttribute?.('placeholder') || 'Filter';

export function initMobileToolbars() {
  const instances = new Set();
  let toolbarSequence = 0;
  let openSheets = 0;
  const lockPage = () => { openSheets++; document.documentElement.classList.add('mobile-filter-open'); };
  const unlockPage = () => { openSheets = Math.max(0, openSheets - 1); if (!openSheets) document.documentElement.classList.remove('mobile-filter-open'); };
  const selectors = '.ops-toolbar,.master-filters,.table-tools,.box-req-toolbar,.order-analytics-filters,.order-filter-form';
  function setup(toolbar) {
    if (toolbar.dataset.mobileToolbar || toolbar.closest('dialog') || toolbar.closest('.ops-panel')?.querySelector('#payment-body')) return;
    const special = toolbar.matches('.order-filter-form,.order-analytics-filters');
    const desktopCompact = toolbar.matches('.order-analytics-filters') || Boolean(toolbar.closest('.collections-section'));
    const compact = () => mobile() || desktopCompact;
    const children = special ? [...toolbar.children] : [...toolbar.children];
    const searchNode = children.find((node) => node.matches?.('input[type="search"]') || node.querySelector?.('input[type="search"]'));
    const search = control(searchNode);
    const filterNodes = special ? children.filter((node) => node !== searchNode && !node.matches?.('.order-active-filters,.order-filter-pending,.analytics-filter-actions,.order-filter-actions')).flatMap((node) => node.matches('.order-filter-grid') ? [...node.children] : [node]) : children.filter((node) => node !== searchNode && (node.matches?.('input,select,textarea') || control(node)));
    const actionNodes = children.filter((node) => node.matches?.('button,.analytics-filter-actions,.order-filter-actions'));
    const exportButton = toolbar.querySelector('button[id*="export"]');
    if (!search && !filterNodes.length && !exportButton) return;
    toolbar.dataset.mobileToolbar = 'true';
    if (desktopCompact) toolbar.classList.add('is-compact-source');
    const page = toolbar.closest('.page-view');
    const title = page?.querySelector('.section-heading h2,.section-heading h3,.master-toolbar h3,.table-toolbar h3')?.textContent?.trim() || page?.getAttribute('aria-label') || 'Records';
    const dock = document.createElement('div'); dock.className = 'mobile-filter-dock'; if (desktopCompact) dock.classList.add('is-desktop-compact');
    const filterId = `mobile-filter-${++toolbarSequence}`; dock.dataset.filterId = filterId;
    const searchWrap = document.createElement('div'); searchWrap.className = 'mobile-search-wrap';
    const clearSearch = document.createElement('button'); clearSearch.type = 'button'; clearSearch.className = 'mobile-search-clear'; clearSearch.setAttribute('aria-label', 'Clear search'); clearSearch.textContent = '×';
    if (searchNode) {
      const anchor = document.createComment('search'); searchNode.before(anchor);
      searchWrap.append(searchNode, clearSearch); dock.append(searchWrap);
      clearSearch.onclick = () => { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); search.focus(); };
      const updateSearch = () => { clearSearch.hidden = !search.value; }; search.addEventListener('input', updateSearch); updateSearch();
      if (toolbar.matches('.order-filter-form')) { let timer; search.addEventListener('input', () => { if (!mobile()) return; clearTimeout(timer); timer = setTimeout(() => toolbar.querySelector('#order-apply')?.click(), 180); }); }
      searchNode._mobileAnchor = anchor;
    }
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'button button-outline mobile-filter-trigger'; trigger.innerHTML = '☷ <span>Filter</span><b hidden>0</b>';
    if (filterNodes.length) dock.append(trigger);
    const chips = document.createElement('div'); chips.className = 'mobile-filter-chips'; chips.setAttribute('aria-label', 'Active filters');
    const dialog = document.createElement('dialog'); dialog.className = 'mobile-filter-sheet'; if (desktopCompact) dialog.classList.add('is-desktop-compact'); dialog.setAttribute('aria-label', `${title} filters`);
    dialog.dataset.filterId = filterId;
    dialog.innerHTML = `<div class="mobile-filter-header"><h2>${title} filters</h2><button type="button" class="mobile-filter-close" aria-label="Close filters">×</button></div><div class="mobile-filter-fields"></div><div class="mobile-filter-footer"><button type="button" class="button button-outline mobile-filter-clear">Clear All</button><button type="button" class="button button-primary mobile-filter-apply">Apply Filters</button></div>`;
    // Scoped modules query their own subtree by ID. Keep moved filter controls there.
    (toolbar.closest('.collections-section') || page || document.body).append(dialog);
    const fieldBox = dialog.querySelector('.mobile-filter-fields');
    const restore = new Map();
    for (const node of filterNodes) { const anchor = document.createComment('filter'); node.before(anchor); restore.set(node, anchor); }
    const fields = filterNodes.flatMap((node) => node.matches('input,select,textarea') ? [node] : [...node.querySelectorAll('input,select,textarea')]);
    const defaults = new Map(fields.map((field) => [field, field.value]));
    const applied = new Map(fields.map((field) => [field, field.value]));
    let committing = false;
    let sheetLocked = false;
    const releaseSheet = () => { if (sheetLocked) { sheetLocked = false; unlockPage(); } };
    const closeSheet = () => { if (dialog.open) dialog.close(); releaseSheet(); };
    const dispatch = (field) => { committing = true; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); committing = false; };
    function updateChips() {
      const active = fields.filter((field) => applied.get(field) !== defaults.get(field) && applied.get(field) !== '');
      trigger.querySelector('b').hidden = !active.length; trigger.querySelector('b').textContent = active.length;
      chips.replaceChildren();
      for (const field of active) {
        const node = filterNodes.find((item) => item === field || item.contains(field));
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'mobile-filter-chip';
        const value = field.tagName === 'SELECT' ? field.selectedOptions[0]?.textContent : field.value;
        chip.textContent = `${labelText(node)}: ${value} ×`;
        chip.onclick = () => { field.value = defaults.get(field); applied.set(field, field.value); dispatch(field); updateChips(); };
        chips.append(chip);
      }
      if (active.length) { const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'mobile-filter-clear-link'; clear.textContent = 'Clear All'; clear.onclick = clearAll; chips.append(clear); }
    }
    function apply() {
      for (const field of fields) if (field.value !== applied.get(field)) { applied.set(field, field.value); dispatch(field); }
      const applyButton = actionNodes.flatMap((node) => node.matches('button') ? [node] : [...node.querySelectorAll('button')]).find((button) => /apply/i.test(button.textContent));
      applyButton?.click(); updateChips(); closeSheet();
    }
    function clearAll() { for (const field of fields) { if (field.value !== defaults.get(field) || applied.get(field) !== defaults.get(field)) { field.value = defaults.get(field); applied.set(field, field.value); dispatch(field); } } const applyButton = actionNodes.flatMap((node) => node.matches('button') ? [node] : [...node.querySelectorAll('button')]).find((button) => /apply/i.test(button.textContent)); applyButton?.click(); updateChips(); closeSheet(); }
    trigger.onclick = () => {
      if (!compact() || dialog.open) return;
      // The page can reset controls when the active user or module changes.
      for (const field of fields) applied.set(field, field.value ?? '');
      updateChips();
      dialog.showModal();
      lockPage();
      sheetLocked = true;
    };
    dialog.querySelector('.mobile-filter-close').onclick = closeSheet;
    dialog.querySelector('.mobile-filter-apply').onclick = apply;
    dialog.querySelector('.mobile-filter-clear').onclick = clearAll;
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeSheet(); });
    dialog.addEventListener('close', () => { for (const field of fields) field.value = applied.get(field) ?? ''; releaseSheet(); });
    // Existing handlers run only after Apply while the drawer is open.
    for (const type of ['input', 'change']) fieldBox.addEventListener(type, (event) => { if (!committing && fields.includes(event.target)) event.stopPropagation(); }, true);
    const primaryAnchor = page?.id === 'payments-view' ? (toolbar.closest('.collections-section') ? page.querySelector('.payment-actions') : null) : page?.querySelector(':scope > .section-heading');
    if (primaryAnchor && !page.querySelector(':scope > .mobile-filter-dock')) { dock.classList.add('is-primary'); primaryAnchor.after(dock, chips); }
    else toolbar.before(dock, chips);
    const exportAnchor = exportButton ? document.createComment('export') : null;
    if (exportButton) {
      exportButton.before(exportAnchor); exportButton.classList.add('mobile-export-action'); exportButton.setAttribute('aria-label', 'Export'); exportButton.title = 'Export';
      let timeout;
      const finish = () => { clearTimeout(timeout); exportButton.removeAttribute('aria-busy'); document.removeEventListener('oms:export-complete', finish); };
      exportButton.addEventListener('click', () => { exportButton.setAttribute('aria-busy', 'true'); document.addEventListener('oms:export-complete', finish); timeout = setTimeout(finish, /analytics-export|order-export/.test(exportButton.id) ? 600 : 15000); });
    }
    const sheetAction = (button) => /^(apply(?: filters)?|clear(?: all| filters)?)$/i.test(button.textContent.trim());
    const extraButtons = actionNodes.flatMap((node) => node.matches('button') ? [node] : [...node.querySelectorAll('button')]).filter((node) => node !== exportButton && !sheetAction(node));
    const extraAnchors = new Map(extraButtons.map((button) => { const anchor = document.createComment('action'); button.before(anchor); return [button, anchor]; }));
    const sourceActions = actionNodes.flatMap((node) => node.matches('button') ? [node] : [...node.querySelectorAll('button')]).filter(sheetAction);
    const sourceActionAnchors = new Map(sourceActions.map((button) => { const anchor = document.createComment('source action'); button.before(anchor); return [button, anchor]; }));
    const hiddenActions = document.createElement('div'); hiddenActions.hidden = true; toolbar.append(hiddenActions);
    function arrange() {
      for (const node of filterNodes) {
        if (compact()) {
          if (node.parentElement !== fieldBox && !fieldBox.contains(node)) {
            // Reuse an existing field label. Wrapping it in another label repeats its text.
            if (node.matches('label') || node.querySelector('label')) {
              node.classList.add('mobile-filter-field');
              fieldBox.append(node);
            } else {
              const wrapper = document.createElement('label'); wrapper.className = 'mobile-filter-field';
              wrapper.textContent = labelText(node); wrapper.append(node); fieldBox.append(wrapper);
            }
          }
        } else {
          const wrapper = node.parentElement?.classList.contains('mobile-filter-field') && node.parentElement !== fieldBox ? node.parentElement : null;
          restore.get(node)?.after(node); wrapper?.remove(); node.classList.remove('mobile-filter-field');
        }
      }
      if (exportButton) { if (compact()) dock.append(exportButton); else exportAnchor.after(exportButton); }
      for (const button of extraButtons) { if (compact()) dock.append(button); else extraAnchors.get(button).after(button); }
      for (const button of sourceActions) { if (compact()) hiddenActions.append(button); else sourceActionAnchors.get(button).after(button); }
      if (searchNode && !compact()) searchNode._mobileAnchor.after(searchNode);
      else if (searchNode && !searchWrap.contains(searchNode)) searchWrap.prepend(searchNode);
      dock.hidden = !compact(); chips.hidden = !compact();
      if (!compact() && dialog.open) closeSheet();
    }
    instances.add(arrange); arrange(); updateChips();
  }
  function scan() { document.querySelectorAll(selectors).forEach(setup); }
  scan();
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; scan(); }); }).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', () => instances.forEach((arrange) => arrange()));
}
