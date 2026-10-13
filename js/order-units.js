export const ORDER_UNITS = Object.freeze([
  Object.freeze({ id: 'kg', label: 'KG' }),
  Object.freeze({ id: '500gm', label: '500 GM' }),
  Object.freeze({ id: '250gm', label: '250 GM', adminOnly: true }),
]);

export const orderUnitLabel = (unit) => {
  if (typeof unit === 'string') return ORDER_UNITS.find((choice) => choice.id === unit)?.label || null;
  const name = String(unit?.name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (['KG', '1 KG', '1KG', 'KILOGRAM'].includes(name)) return 'KG';
  if (['500 GM', '500 G', '500GM', '500G'].includes(name)) return '500 GM';
  if (['250 GM', '250 G', '250GM', '250G'].includes(name)) return '250 GM';
  return null;
};

export const availableOrderUnits = (role) => ORDER_UNITS.filter((unit) => !unit.adminOnly || role === 'admin');

export const orderLineUnitLabel = (line) => line?.orderUnitName || line?.itemSnapshot?.unitSymbol || '';

export const itemUnitPrice = (item, unitId) => {
  if (unitId === 'kg') return item?.defaultSellingPrice;
  if (unitId === '500gm') return item?.sellingPrice500Gm;
  if (unitId === '250gm') return item?.sellingPrice250Gm;
  return item?.defaultSellingPrice; // Historical Unit Master IDs keep their original item price.
};
