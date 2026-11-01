const paths = {
  view: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="m4 20 4.2-.8L19 8.4 15.6 5 4.8 15.8 4 20Z"/><path d="m13.8 6.8 3.4 3.4"/>',
  invoice: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
  share: '<circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/>',
  payment: '<path d="M3 6h18v12H3zM3 10h18M7 15h4"/>',
  phone: '<path d="M5 3h4l1 5-2 2a15 15 0 0 0 6 6l2-2 5 1v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
  order: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
  receipt: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  reject: '<path d="M5 5 19 19M19 5 5 19"/>',
};

export function cardIcon(name) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.view}</svg>`;
}

export function cardButton(kind, id, label, icon, dataAttribute = 'data-finance', displayLabel = label) {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<button type="button" class="order-card-action" ${dataAttribute}="${escape(kind)}" data-id="${escape(id)}" aria-label="${escape(label)}" title="${escape(label)}">${cardIcon(icon)}<span>${escape(displayLabel)}</span></button>`;
}

export function cardMore(label, actions) {
  if (!actions.length) return '';
  return `<details class="order-card-more"><summary aria-label="More actions for ${label}" title="More actions">${cardIcon('more')}<span>More</span></summary><div class="order-card-menu">${actions.join('')}</div></details>`;
}
