export function lineQuantity(line) {
  if (!Number.isSafeInteger(line.quantityQty) || line.quantityQty < 0) return null;
  const factors = { kg: 1000, '1kg': 1000, kilogram: 1000, '500gm': 500, '500g': 500, '250gm': 250, '250g': 250, gm: 1, g: 1, pcs: null, piece: null, pieces: null };
  const unit = [line.orderUnitId, line.orderUnitName, line.unitSymbol].map((value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '')).find((value) => Object.hasOwn(factors, value));
  const factor = factors[unit];
  if (factor === undefined) return null;
  return factor === null ? { unit: 'PCS', value: line.quantityQty / 1000 } : { unit: 'KG', value: line.quantityQty * factor / 1000000 };
}

export function analyticsColumns(data) {
  const byId = new Map((data.items || []).map((item) => [item.id, item]));
  const columns = new Map();
  for (const item of data.items || []) { const unit = /^(PCS|PIECES?)$/i.test(item.unitSymbol || '') ? 'PCS' : 'KG'; columns.set(`${item.id}:${unit}`, { key: `${item.id}:${unit}`, name: item.name, unit }); }
  for (const order of data.orders || []) for (const line of order.lines || []) {
    const quantity = lineQuantity(line);
    if (!quantity) continue;
    const key = `${line.productId}:${quantity.unit}`;
    if (!columns.has(key)) columns.set(key, { key, name: byId.get(line.productId)?.name || line.name || 'Archived item', unit: quantity.unit });
  }
  return [...columns.values()].sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit));
}

export function matchingOrders(data, filters = {}) {
  const search = String(filters.search || '').trim().toLocaleLowerCase();
  return (data.orders || []).filter((order) => (!filters.user || order.assignedUserId === filters.user)
    && (!filters.from || order.orderDate >= filters.from) && (!filters.to || order.orderDate <= filters.to)
    && (!filters.status || order.status === filters.status || filters.status === 'invoiced' && Boolean(order.invoiceId))
    && (!search || [order.orderNumber, order.customerName, order.status, (data.users || []).find((user) => user.id === order.assignedUserId)?.name].some((value) => String(value || '').toLocaleLowerCase().includes(search))));
}

export function quantities(orders, columns) {
  const result = Object.fromEntries(columns.map((column) => [column.key, 0]));
  for (const order of orders) for (const line of order.lines || []) {
    const quantity = lineQuantity(line);
    const key = `${line.productId}:${quantity?.unit}`;
    if (quantity && Object.hasOwn(result, key)) result[key] += quantity.value;
  }
  return result;
}

export function quantityText(value, unit) {
  return `${Number(value.toFixed(3)).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`;
}

export function totalText(values, columns) {
  const sums = { KG: 0, PCS: 0 };
  for (const column of columns) sums[column.unit] += values[column.key] || 0;
  return Object.entries(sums).filter(([, value]) => value).map(([unit, value]) => quantityText(value, unit)).join(' + ') || '0 KG';
}

// Status order for the detail table: Draft, Confirmed, In preparation, Ready,
// Delivered, then any unfamiliar status. Payment states within an order status
// run Unpaid, Payment in process, Partially paid, Paid.
const STATUS_ORDER = ['draft', 'confirmed', 'in_preparation', 'ready', 'delivered'];
export function statusSortValue(status, display = '') {
  const index = STATUS_ORDER.indexOf(status);
  const payment = /paid$/i.test(display) && !/partially paid$/i.test(display) && !/unpaid$/i.test(display) ? 3
    : /partially paid$/i.test(display) ? 2 : /payment in process$/i.test(display) ? 1 : 0;
  return [index < 0 ? STATUS_ORDER.length : index, payment];
}

// Numeric values and numeric tuples stay numeric. The ID tie-breaker makes
// equal values deterministic when Firestore returns records in another order.
export function sortAnalyticsRows(rows, sort) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const compare = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      const left = Array.isArray(a) ? a : [a], right = Array.isArray(b) ? b : [b];
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = Number(left[index] || 0) - Number(right[index] || 0);
        if (difference) return difference;
      }
      return 0;
    }
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return collator.compare(String(a ?? ''), String(b ?? ''));
  };
  const direction = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => direction * compare(left.sortValues[sort.key], right.sortValues[sort.key]) || collator.compare(String(left.id), String(right.id)));
}

export function analyticsCsv(headers, rows, footer) {
  const cell = (value) => { const text = String(value ?? ''); return `"${(/^\s*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`; };
  return `\uFEFF${[headers, ...rows, footer].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
