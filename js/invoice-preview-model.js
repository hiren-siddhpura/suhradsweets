import { availableOrderUnits, itemUnitPrice } from './order-units.js';
import { invoiceAmountWords } from './invoice-amount-words.js';

const packing = (item) => String(item?.name || '').trim().toLowerCase() === 'gift packing';
export const previewUnits = (item, role, kind = 'item') => kind === 'special'
  ? Number.isSafeInteger(item?.finalPricePaise) && item.finalPricePaise >= 0 ? [{ id: 'combo', label: 'Combo' }] : []
  : availableOrderUnits(role).filter((unit) => packing(item) ? unit.id === 'pcs' : unit.id !== 'pcs').filter((unit) => {
  const price = itemUnitPrice(item, unit.id);
  return typeof price === 'number' && Number.isFinite(price) && price >= 0 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-7;
});
export function previewPrice(item, unitId, kind = 'item') {
  if (!previewUnits(item, 'admin', kind).some((unit) => unit.id === unitId)) throw new Error('This item has no current price for the selected unit.');
  if (kind === 'special') return item.finalPricePaise;
  return Math.round(itemUnitPrice(item, unitId) * 100);
}
export function previewProductLine(item, kind, unitId, quantityQty = 1000) {
  const unit = previewUnits(item, 'admin', kind).find((entry) => entry.id === unitId);
  if (!item?.id || !unit) throw new Error('Choose an available item and unit.');
  const unitPricePaise = previewPrice(item, unitId, kind);
  return { kind, productId: item.id, description: item.name, unitId, unit: unit.label, quantityQty, unitPricePaise, lineTotalPaise: previewTotal(quantityQty, unitPricePaise) };
}
export function previewTotal(quantityQty, unitPricePaise) {
  if (!Number.isSafeInteger(quantityQty) || quantityQty < 1000 || quantityQty % 1000 || !Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) throw new Error('Enter a whole-number quantity and valid price.');
  const total = quantityQty / 1000 * unitPricePaise;
  if (!Number.isSafeInteger(total) || total > 1_000_000_000_000) throw new Error('Preview total is too large.');
  return total;
}
export function validatePreview(input) {
  const customer = input?.customerSnapshot || {};
  for (const [key, limit] of [['fullName', 120], ['contact', 80], ['area', 100], ['address', 300]]) {
    if (typeof customer[key] !== 'string' || customer[key].length > limit || (key === 'fullName' && !customer[key].trim())) throw new Error('Enter valid customer details.');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) throw new Error('Add 1 to 20 preview items.');
  const subtotal = input.lines.reduce((sum, line) => {
    if (typeof line.productId !== 'string' || !line.productId || !['item', 'special', undefined].includes(line.kind) || typeof line.description !== 'string' || !line.description || typeof line.unit !== 'string' || !line.unit) throw new Error('Choose a valid item and unit.');
    if (previewTotal(line.quantityQty, line.unitPricePaise) !== line.lineTotalPaise) throw new Error('Preview line total is invalid.');
    return sum + line.lineTotalPaise;
  }, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > 1_000_000_000_000) throw new Error('Preview total is too large.');
  return { ...input, customerSnapshot: Object.fromEntries(Object.entries(customer).map(([key, value]) => [key, value.trim()])), subtotal, totalPaise: subtotal };
}
export function previewFilename(preview) {
  const name = String(preview.customerSnapshot?.fullName || 'Customer').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'Customer';
  return `${name} - Invoice Preview - ${preview.reference || preview.id || Date.now()}.pdf`;
}
export function previewInvoice(preview) {
  return { documentType: 'preview', invoiceNumber: preview.reference, issuedAt: preview.updatedAt?.toDate?.() ? preview.updatedAt : preview.updatedAt instanceof Date ? preview.updatedAt.toISOString().slice(0, 10) : typeof preview.updatedAt === 'string' ? preview.updatedAt : new Date().toISOString().slice(0, 10), customerSnapshot: preview.customerSnapshot, lines: preview.lines.map((line) => ({ ...line, unit: line.unit })), subtotal: preview.subtotal, totalPaise: preview.totalPaise, verifiedPaidPaise: 0 };
}
export const previewAmountWords = (preview) => invoiceAmountWords(preview.totalPaise);
