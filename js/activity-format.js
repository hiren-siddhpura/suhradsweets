const ACTIONS = {
  'payment.submitted': 'Payment submitted', 'payment.verified': 'Payment verified', 'payment.rejected': 'Payment rejected', 'payment.reversed': 'Payment reversed', 'payment.mode_changed': 'Payment method updated',
  'invoice.created': 'Invoice created', 'invoice.marked_paid': 'Invoice marked as paid',
  'order.created': 'Order created', 'order.confirmed': 'Order confirmed', 'order.edited': 'Order updated', 'order.locked': 'Order editing locked', 'order.invoice_created': 'Invoice created', 'order.status_changed': 'Order status updated', 'order.cancelled': 'Order cancelled', 'order.draft_cancelled': 'Draft order cancelled', 'order.archived': 'Order archived', 'order.restored': 'Order restored', 'order.payment_submitted': 'Payment submitted', 'order.payment_requested': 'Payment requested', 'order.stock_deducted': 'Stock deducted',
  'customer.created': 'Customer added', 'customer.updated': 'Customer updated', 'customer.deleted': 'Customer deleted', 'customer.import_completed': 'Customer import completed',
  'inventory.adjusted': 'Stock adjusted', 'stock.adjusted': 'Stock adjusted', 'inventory.received': 'Stock received', 'inventory.reserved': 'Stock reserved', 'inventory.released': 'Stock reservation released', 'inventory.deducted': 'Stock deducted', 'inventory.restored': 'Stock restored', 'inventory.blocked': 'Item blocked', 'inventory.unblocked': 'Item unblocked', 'purchase.created': 'Purchase created', 'purchase.edited': 'Purchase updated', 'purchase.confirmed': 'Purchase confirmed', 'purchase.cancelled': 'Purchase cancelled',
  'user.created': 'User created', 'user.updated': 'User profile updated', 'user.activated': 'User activated', 'user.deactivated': 'User deactivated', 'user.setup_link_sent': 'Password setup link sent',
};
const LABELS = { amountPaise: 'Payment amount', verifiedPaidPaise: 'Verified payment total', totalPaise: 'Invoice total', grandTotal: 'Order total', unitPricePaise: 'Unit price', mode: 'Payment method', verificationStatus: 'Payment verification status', invoiceStatus: 'Invoice status', editLocked: 'Order editing status', status: 'Order status', quantityQty: 'Quantity', orderUnitId: 'Unit', stockDeductions: 'Stock changes' };
const PAISE = new Set(['amountPaise', 'verifiedPaidPaise', 'totalPaise', 'grandTotal', 'unitPricePaise']);
const STATUS = { unverified: 'Pending verification', verified: 'Verified', rejected: 'Rejected', reversed: 'Reversed', unpaid: 'Unpaid', in_process: 'In process', partial: 'Partly paid', paid: 'Paid', draft: 'Draft', confirmed: 'Confirmed', in_preparation: 'In preparation', ready: 'Ready', delivered: 'Delivered', cancelled: 'Cancelled' };
const MODES = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer' };

export const actionLabel = (type) => ACTIONS[type] || String(type || 'Activity').replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
export const activityDate = (value) => {
  const date = value?.toDate?.() || (typeof value === 'number' || typeof value === 'string' ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not available';
};
export const money = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `₹${(Number(value) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Not available';
const safeObject = (value) => {
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
  }
  return value;
};
const readable = (key, value) => {
  if (value === null || value === undefined || value === '') return 'Not available';
  if (PAISE.has(key)) return money(value);
  if (key === 'quantityQty') return Number.isFinite(Number(value)) ? (Number(value) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : 'Not available';
  if (key === 'mode') return MODES[value] || String(value).replace(/_/g, ' ');
  if (/status/i.test(key)) return STATUS[value] || String(value).replace(/_/g, ' ');
  if (key === 'editLocked') return value ? 'Locked' : 'Editable';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'Updated';
};
const lineSummary = (entries) => Array.isArray(entries) && entries.length ? entries.slice(0, 3).map((entry) => {
  const data = safeObject(entry) || {}; const name = data.itemSnapshot?.name || data.name || data.itemName || 'Item';
  const quantity = data.quantityQty == null ? '' : ` ${readable('quantityQty', data.quantityQty)}`;
  const unit = data.orderUnitName || data.unit || '';
  return `${name}${quantity}${unit ? ` ${unit}` : ''}`;
}).join(', ') + (entries.length > 3 ? ' and more' : '') : '';

export function changeSummary(event = {}) {
  const detail = safeObject(event.detail) || {};
  const changes = safeObject(event.changedFields) || safeObject(detail.changedFields) || detail;
  const reason = event.reason || detail.reason;
  const parts = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    if (['before', 'after', 'reason', 'changedFields', 'import'].includes(key)) continue;
    if (key === 'inventory') {
      const inventory = safeObject(raw);
      if (inventory?.kind === 'none') parts.push('No inventory change');
      else if (['stock_restored', 'reservation_released'].includes(inventory?.kind) && Array.isArray(inventory.items)) {
        const label = inventory.kind === 'stock_restored' ? 'Stock restored' : 'Reservation released';
        const items = inventory.items.map((item) => `${item.itemName || 'Item'} ${readable('quantityQty', item.onHandQtyRestored ?? item.reservedQtyReleased)} ${item.unitSymbol || ''}`.trim()).join(', ');
        if (items) parts.push(`${label}: ${items}`);
      }
      continue;
    }
    if (key === 'stockDeductions' || key === 'lines') { const summary = lineSummary(raw); if (summary) parts.push(`${LABELS[key] || 'Order items'}: ${summary}`); continue; }
    const value = safeObject(raw);
    if (value && Object.hasOwn(value, 'before') && Object.hasOwn(value, 'after')) {
      const before = readable(key, value.before), after = readable(key, value.after);
      if (before !== after) parts.push(`${LABELS[key] || key} changed from ${before} to ${after}`);
    } else if (PAISE.has(key) || LABELS[key]) parts.push(`${LABELS[key] || key}: ${readable(key, raw)}`);
  }
  if (!parts.length) {
    if (event.type === 'order.locked') parts.push('Order editing locked because the invoice was created');
    else if (event.type === 'order.confirmed') parts.push('Order confirmed');
    else if (event.type === 'order.invoice_created') parts.push('Invoice created; order editing locked');
    else if (/\.edited$|\.updated$/.test(event.type || '')) parts.push('Details updated');
    else parts.push('No additional details available');
  }
  if (reason) parts.push(`Reason: ${String(reason)}`);
  return parts.join('. ');
}

export function references(event = {}, fallback = {}) {
  const detail = safeObject(event.detail) || {};
  return {
    customer: event.customerName || event.customerSnapshot?.fullName || detail.customerName || detail.after?.fullName || detail.before?.fullName || fallback.customer || 'Not available',
    order: event.orderNumber || detail.orderNumber || fallback.order || 'Not available',
    invoice: event.invoiceNumber || detail.invoiceNumber || fallback.invoice || 'Not available',
    actor: event.actorName || event.submittedByName || event.verifiedByName || fallback.actor || 'Not available',
    amount: event.amountPaise ?? detail.amountPaise ?? fallback.amount,
    mode: event.mode || detail.mode || fallback.mode || '',
  };
}
