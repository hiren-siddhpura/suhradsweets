import { ORDER_UNITS, orderUnitLabel } from './order-units.js';

export const BOX_UNITS = Object.freeze(['250gm', '500gm', 'kg'].map((id) => Object.freeze([id, id === 'kg' ? '1 KG' : ORDER_UNITS.find((unit) => unit.id === id).label])));
const ACTIVE_STATUSES = new Set(['confirmed', 'in_preparation', 'ready', 'delivered']);
const EMPTY_COUNTS = () => ({ '250gm': 0, '500gm': 0, kg: 0 });

function packagingId(line) {
  const label = orderUnitLabel(line.orderUnitId)
    || orderUnitLabel({ name: line.orderUnitName })
    || orderUnitLabel({ name: line.itemSnapshot?.unitSymbol });
  return label === '250 GM' ? '250gm' : label === '500 GM' ? '500gm' : label === 'KG' ? 'kg' : null;
}

export function calculateBoxRequirements(orders) {
  const items = new Map(), seen = new Set(), totals = EMPTY_COUNTS();
  let orderCount = 0;
  for (const order of orders) {
    if (!ACTIVE_STATUSES.has(order.status) || !order.id || seen.has(order.id)) continue;
    seen.add(order.id);
    orderCount++;
    for (const line of order.lines || []) {
      if (line.kind !== 'item') continue; // Combo contents do not identify a box size.
      const name = String(line.itemSnapshot?.name || '').trim();
      const unit = packagingId(line);
      const quantity = line.quantityQty;
      if (!name || !unit || !Number.isSafeInteger(quantity) || quantity < 0 || quantity % 1000 !== 0) {
        throw new Error(`Order ${order.orderNumber || order.id} has an item line with an unsupported box size or quantity.`);
      }
      const boxes = quantity / 1000;
      const key = line.productId || `name:${name.toLocaleLowerCase()}`;
      if (!items.has(key)) items.set(key, { id: key, name, quantities: EMPTY_COUNTS() });
      const item = items.get(key);
      item.name = name;
      if (!Number.isSafeInteger(item.quantities[unit] + boxes) || !Number.isSafeInteger(totals[unit] + boxes)) throw new Error('Box total exceeds the supported range.');
      item.quantities[unit] += boxes;
      totals[unit] += boxes;
    }
  }
  return { items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)), totals, orderCount };
}
