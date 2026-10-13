export const MASTER_TYPES = Object.freeze(['items', 'units', 'purchaseTypes', 'users', 'settings']);

export const MASTER_LABELS = Object.freeze({
  items: 'Item', units: 'Unit', purchaseTypes: 'Purchase type', users: 'User profile', settings: 'Setting',
});

const text = (value) => String(value ?? '').trim();

function required(value, label, max = 120) {
  const result = text(value);
  if (!result) throw new Error(`${label} is required.`);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return result;
}

function optional(value, label, max = 500) {
  const result = text(value);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return result;
}

export function normalizeItemCode(value) {
  const code = required(value, 'Item code', 32).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) {
    throw new Error('Item code must be 2–32 letters, numbers, hyphens or underscores.');
  }
  return code;
}

export function hasDuplicateItemName(items, candidate, currentId = null) {
  const name = String(candidate.name ?? '').trim().toLocaleLowerCase();
  return items.some((item) => item.id !== currentId
    && item.defaultUnitId === candidate.defaultUnitId
    && String(item.name ?? '').trim().toLocaleLowerCase() === name);
}

export function validateMasterInput(type, input, { existing = null, actorRole = null } = {}) {
  if (!MASTER_TYPES.includes(type)) throw new Error('Unknown master-data collection.');
  const active = input.active === true;
  if (type === 'items') {
    const itemCode = normalizeItemCode(input.itemCode);
    if (existing && itemCode !== existing.itemCode) throw new Error('Item code cannot be changed after creation. Create a new item code instead.');
    const priceText = text(input.defaultSellingPrice);
    if (!/^\d+(\.\d{1,2})?$/.test(priceText)) throw new Error('Enter a nonnegative selling price with at most two decimal places.');
    const price = Number(priceText);
    if (!Number.isFinite(price) || price > 100000000) throw new Error('Selling price must be between ₹0 and ₹100,000,000.');
    const unitPrice = (value, label) => {
      const entered = text(value);
      if (!entered) return undefined;
      if (!/^\d+(\.\d{1,2})?$/.test(entered) || Number(entered) > 100000000) throw new Error(`${label} must be a nonnegative price with at most two decimal places.`);
      return Number(entered);
    };
    const sellingPrice500Gm = unitPrice(input.sellingPrice500Gm, '500 GM price');
    const sellingPrice250Gm = unitPrice(input.sellingPrice250Gm, '250 GM price');
    return { itemCode, name: required(input.name, 'Name'), description: optional(input.description, 'Description'),
      defaultSellingPrice: price, ...(sellingPrice500Gm !== undefined ? { sellingPrice500Gm } : {}), ...(sellingPrice250Gm !== undefined ? { sellingPrice250Gm } : {}), defaultUnitId: required(input.defaultUnitId, 'Default unit ID', 128), active };
  }
  if (type === 'units') return { name: required(input.name, 'Name'), symbol: required(input.symbol, 'Symbol', 16), active };
  if (type === 'purchaseTypes') return { name: required(input.name, 'Name'), description: optional(input.description, 'Description'), active };
  if (type === 'settings') return { key: required(input.key, 'Key', 80), value: required(input.value, 'Value', 1000), description: optional(input.description, 'Description'), active };
  const role = required(input.role, 'Role', 20);
  if (!['admin', 'account_admin', 'user'].includes(role)) throw new Error('Choose a valid role.');
  if (actorRole === 'account_admin' && role !== 'user') throw new Error('Only an Admin can assign staff roles.');
  if (existing && actorRole === 'account_admin' && existing.role !== role) throw new Error('Only an Admin can change roles.');
  const email = required(input.email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  return { fullName: required(input.fullName || input.displayName, 'Full name', 80), email, role, active };
}
