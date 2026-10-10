export const DASHBOARD_TARGET_ID = 'dashboard_sales_target';
export const DASHBOARD_TARGET_KEY = 'dashboardSalesTargetKg';
const eligible = new Set(['confirmed', 'in_preparation', 'ready', 'delivered']);

export function quantityInKg(quantityQty, symbol) {
  if (!Number.isSafeInteger(quantityQty) || quantityQty < 0) return null;
  const unit = String(symbol || '').trim().toLowerCase();
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(unit)) return quantityQty / 1000;
  if (['g', 'gm', 'gms', 'gram', 'grams'].includes(unit)) return quantityQty / 1000000;
  return null;
}

export function summarizeOrderKg(orders) {
  let orderCount = 0, totalKg = 0, excludedQuantities = 0;
  const items = new Map();
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    orderCount++;
    if (!eligible.has(order.status)) continue;
    // Confirmation snapshots include special-product components exactly once.
    const parts = Array.isArray(order.stockDeductions) ? order.stockDeductions : (order.lines || []).flatMap((line) => {
      if (line.kind === 'item') return [{ itemId: line.productId, quantityQty: line.quantityQty, itemSnapshot: line.itemSnapshot }];
      if (line.kind === 'special') return (line.specialSnapshot?.components || []).map((part) => ({ ...part, quantityQty: part.quantityQty * line.quantityQty / 1000 }));
      return [];
    });
    for (const part of parts) {
      const kg = quantityInKg(part.quantityQty, part.itemSnapshot?.unitSymbol);
      if (kg === null) { excludedQuantities++; continue; }
      const previous = items.get(part.itemId) || { itemId: part.itemId, name: part.itemSnapshot?.name || part.itemId, kg: 0 };
      previous.kg += kg; items.set(part.itemId, previous); totalKg += kg;
    }
  }
  return { orderCount, totalKg, items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)), excludedQuantities };
}

export function targetPercentage(soldKg, targetKg) {
  return Number.isFinite(targetKg) && targetKg > 0 ? soldKg / targetKg * 100 : null;
}

export function validateTargetKg(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text) || Number(text) > 1000000000) throw new Error('Enter a nonnegative target in KG with at most three decimal places.');
  return text;
}
