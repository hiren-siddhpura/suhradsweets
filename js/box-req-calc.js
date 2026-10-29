import { ORDER_UNITS, orderUnitLabel } from './order-units.js';

export const BOX_UNITS = Object.freeze(['250gm', '500gm', 'kg'].map((id) => Object.freeze([id, id === 'kg' ? '1 KG' : ORDER_UNITS.find((unit) => unit.id === id).label])));
const ACTIVE_STATUSES = new Set(['confirmed', 'in_preparation', 'ready', 'delivered']);
const EMPTY_COUNTS = () => ({ '250gm': 0, '500gm': 0, kg: 0 });
const normalized = (name) => String(name || '').trim().toLocaleLowerCase();
const packing = (name) => ['gift packing', 'gift wrapping'].includes(normalized(name));
function addRequirement(map, key, name, unit, quantity) {
  const id = `${key}:${unit}`;
  const next = (map.get(id)?.quantity || 0) + quantity;
  if (!Number.isSafeInteger(next)) throw new Error('Requirement total exceeds the supported range.');
  map.set(id, { id, name, unit, quantity: next });
}

function packagingId(line) {
  const label = orderUnitLabel(line.orderUnitId)
    || orderUnitLabel({ name: line.orderUnitName })
    || orderUnitLabel({ name: line.itemSnapshot?.unitSymbol });
  return label === '250 GM' ? '250gm' : label === '500 GM' ? '500gm' : label === 'KG' ? 'kg' : null;
}

export function calculateBoxRequirements(orders) {
  const items = new Map(), specials = new Map(), wrapping = new Map(), seen = new Set(), totals = EMPTY_COUNTS();
  let orderCount = 0;
  for (const order of orders) {
    if (!ACTIVE_STATUSES.has(order.status) || !order.id || seen.has(order.id)) continue;
    seen.add(order.id);
    orderCount++;
    const lines = order.lines || [];
    const giftOrder = lines.some((line) => packing(line.itemSnapshot?.name));
    for (const line of lines) {
      if (line.kind !== 'item' && line.kind !== 'special') continue;
      if (line.kind === 'special') {
        const name = String(line.specialSnapshot?.name || '').trim();
        if (!name || !Number.isSafeInteger(line.quantityQty) || line.quantityQty < 0 || line.quantityQty % 1000) throw new Error(`Order ${order.orderNumber || order.id} has an unsupported special quantity.`);
        const quantity = line.quantityQty / 1000, key = line.productId || `name:${normalized(name)}`;
        addRequirement(specials, key, name, 'PCS', quantity);
        if (giftOrder || line.giftWrapping === true) addRequirement(wrapping, `special:${normalized(name)}`, name, 'PCS', quantity);
        continue;
      }
      const name = String(line.itemSnapshot?.name || '').trim();
      if (packing(name)) continue;
      const unit = packagingId(line);
      const quantity = line.quantityQty;
      if (!name || !unit || !Number.isSafeInteger(quantity) || quantity < 0 || quantity % 1000 !== 0) {
        throw new Error(`Order ${order.orderNumber || order.id} has an item line with an unsupported box size or quantity.`);
      }
      const boxes = quantity / 1000;
      const key = line.productId || `name:${name.toLocaleLowerCase()}`;
      if (giftOrder || line.giftWrapping === true) addRequirement(wrapping, `item:${normalized(name)}`, name, orderUnitLabel({ name: line.orderUnitName }) || orderUnitLabel(line.orderUnitId) || orderUnitLabel({ name: line.itemSnapshot?.unitSymbol }) || line.itemSnapshot?.unitSymbol || 'PCS', boxes);
      if (!items.has(key)) items.set(key, { id: key, name, quantities: EMPTY_COUNTS() });
      const item = items.get(key);
      item.name = name;
      if (!Number.isSafeInteger(item.quantities[unit] + boxes) || !Number.isSafeInteger(totals[unit] + boxes)) throw new Error('Box total exceeds the supported range.');
      item.quantities[unit] += boxes;
      totals[unit] += boxes;
    }
  }
  const sorted = (map) => [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.unit || '').localeCompare(b.unit || ''));
  const wrappingTotals = {};
  for (const row of wrapping.values()) {
    const next = (wrappingTotals[row.unit] || 0) + row.quantity;
    if (!Number.isSafeInteger(next)) throw new Error('Gift wrapping total exceeds the supported range.');
    wrappingTotals[row.unit] = next;
  }
  return { items: sorted(items), specials: sorted(specials), wrapping: sorted(wrapping), wrappingTotals, totals, orderCount };
}
