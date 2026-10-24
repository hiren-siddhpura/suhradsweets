import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { audit, fail, money, movement, qty, setStock, stockState, text, validDate, validId } from './operations.js';

const staffRole = (role) => role === 'admin' || role === 'account_admin';
const orderUnitLabel = (unit) => {
  if (typeof unit === 'string') return ({ kg: 'KG', '500gm': '500 GM', '250gm': '250 GM' })[unit] || null;
  const name = String(unit?.name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (['KG', '1 KG', '1KG', 'KILOGRAM'].includes(name)) return 'KG';
  if (['500 GM', '500 G', '500GM', '500G'].includes(name)) return '500 GM';
  if (['250 GM', '250 G', '250GM', '250G'].includes(name)) return '250 GM';
  return null;
};
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const pricePaise = (rupees) => {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees < 0 || rupees > 100_000_000 || Math.abs(rupees * 100 - Math.round(rupees * 100)) > 1e-7) fail('Item selling price must have at most two decimal places.');
  return Math.round(rupees * 100);
};
const saleTotal = (quantityQty, unitPricePaise) => {
  const total = (BigInt(quantityQty) * BigInt(unitPricePaise) + 500n) / 1000n;
  if (total > 1_000_000_000_000n) fail('Order line total is too large.');
  return Number(total);
};
const contactKey = (contact) => createHash('sha256').update(clean(contact).toLowerCase().replace(/[\s()-]/g, '')).digest('hex');

async function actor(db, uid, tx) {
  if (!validId(uid)) fail('Sign in is required.');
  const snap = await tx.get(db.doc(`users/${uid}`));
  if (!snap.exists || snap.data().active !== true || !['admin', 'account_admin', 'user'].includes(snap.data().role)) fail('Active OMS access is required.');
  return { uid, role: snap.data().role, name: snap.data().fullName || snap.data().displayName || 'Unknown user' };
}
function requireStaff(user) { if (!staffRole(user.role)) fail('Access denied: operational staff access is required.'); }
function canManage(user, order) { return staffRole(user.role) || order.ownerUid === user.uid; }
function editableOrder(order) {
  if (!['draft', 'confirmed'].includes(order.status)) fail('Only a Draft or Confirmed order can be edited.');
  if (order.archivedAt) fail('Restore this archived order before editing it.');
}
async function financialLock(db, tx, orderId) {
  if ((await tx.get(db.doc(`invoices/${orderId}`))).exists) fail('This order is locked because an invoice exists.');
  if (!(await tx.get(db.collection('payments').where('orderId', '==', orderId).limit(1))).empty) fail('This order is locked because payment history exists.');
}
export function orderEvent(tx, db, type, user, orderId, order, changedFields = {}, reason = '') {
  tx.create(db.collection('auditLogs').doc(), {
    type, actorUid: user.uid, actorName: user.name, ownerUid: order.ownerUid,
    referenceType: 'order', referenceId: orderId, orderNumber: order.orderNumber,
    customerId: order.customerId, customerName: order.customerSnapshot?.fullName || '',
    detail: { changedFields, reason }, outcome: 'success', at: FieldValue.serverTimestamp(),
  });
}
export async function reassignOrder(db, uid, input) {
  if (!validId(input?.orderId) || !validId(input?.assignedUserId)) fail('Choose an order and an active assigned user.');
  return db.runTransaction(async (tx) => {
    const administrator = await actor(db, uid, tx);
    if (administrator.role !== 'admin') fail('Access denied: only Admin may reassign orders.');
    const orderRef = db.doc(`orders/${input.orderId}`);
    const assigneeRef = db.doc(`users/${input.assignedUserId}`);
    const [orderSnap, assigneeSnap] = await Promise.all([tx.get(orderRef), tx.get(assigneeRef)]);
    if (!orderSnap.exists) fail('Order does not exist.');
    if (!assigneeSnap.exists || assigneeSnap.data().active !== true || !['admin', 'account_admin', 'user'].includes(assigneeSnap.data().role)) fail('Choose an active OMS account.');
    const order = orderSnap.data();
    const previous = order.assignedUserId || order.ownerUid;
    if (previous === input.assignedUserId) return { orderId: input.orderId, assignedUserId: previous, unchanged: true };
    tx.update(orderRef, { assignedUserId: input.assignedUserId, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    orderEvent(tx, db, 'order.reassigned', administrator, input.orderId, order, { assignedUserId: { before: previous, after: input.assignedUserId } });
    return { orderId: input.orderId, assignedUserId: input.assignedUserId };
  });
}
async function takingOrders(db, tx) {
  const control = await tx.get(db.doc('orderControls/global'));
  if (control.exists && control.data().acceptingOrders === false) fail('Order-taking is paused.');
}
function validateCustomer(input) {
  if (!text(input?.fullName, 120) || !text(input.contact, 80) || !text(input.area, 100)) fail('Customer name, contact and area are required.');
  if (typeof input?.address !== 'string' || input.address.trim().length > 300) fail('Address must be 300 characters or fewer.');
  if (input.dateOfBirth && !validDate(input.dateOfBirth)) fail('Enter a valid date of birth.');
  return { fullName: clean(input.fullName), contact: clean(input.contact), address: clean(input.address), area: clean(input.area), dateOfBirth: input.dateOfBirth || null, sabha: input.sabha === true, contactKey: contactKey(input.contact) };
}
function customerSnapshot(data) { return { fullName: data.fullName, contact: data.contact, address: data.address, area: data.area }; }
function itemSnapshot(data, unit) { return { itemCode: data.itemCode, name: data.name, unitId: data.defaultUnitId, unitName: unit.name, unitSymbol: unit.symbol }; }

export async function saveCustomer(db, uid, input) {
  const values = validateCustomer(input);
  const customerId = input.customerId || db.collection('customers').doc().id;
  if (!validId(customerId)) fail('Invalid customer ID.');
  const ref = db.doc(`customers/${customerId}`);
  return db.runTransaction(async (tx) => {
    const staff = await actor(db, uid, tx); requireStaff(staff);
    const existing = await tx.get(ref);
    const assignmentSupplied = Object.hasOwn(input, 'assignedUserId');
    const assignedUserId = assignmentSupplied ? input.assignedUserId : existing.exists ? existing.data().assignedUserId ?? null : null;
    if (assignmentSupplied && staff.role !== 'admin' && assignedUserId !== (existing.exists ? existing.data().assignedUserId ?? null : null)) fail('Only Admin may assign customers.');
    if (assignedUserId !== null) {
      if (!validId(assignedUserId)) fail('Choose an active OMS account.');
      const assignee = await tx.get(db.doc(`users/${assignedUserId}`));
      if (!assignee.exists || assignee.data().active !== true || !['admin', 'account_admin', 'user'].includes(assignee.data().role)) fail('Choose an active OMS account.');
    }
    const reservation = db.doc(`customerContacts/${values.contactKey}`);
    const reserved = await tx.get(reservation);
    const oldReservation = existing.exists && existing.data().contactKey !== values.contactKey ? db.doc(`customerContacts/${existing.data().contactKey}`) : null;
    const oldReserved = oldReservation ? await tx.get(oldReservation) : null;
    if (reserved.exists && reserved.data().customerId !== customerId) fail('A customer with this contact already exists. Search before adding a duplicate.');
    if (oldReservation && oldReserved.exists && oldReserved.data().customerId === customerId) tx.delete(oldReservation);
    if (!reserved.exists) tx.create(reservation, { customerId, createdAt: FieldValue.serverTimestamp() });
    if (existing.exists) {
      tx.update(ref, { ...values, ...(assignmentSupplied ? { assignedUserId } : {}), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    } else {
      tx.create(ref, { ...values, assignedUserId, ownerUserIds: [], orderLinks: {}, createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    audit(tx, db, existing.exists ? 'customer.updated' : 'customer.created', uid, 'customer', customerId, { contactChanged: existing.exists && existing.data().contactKey !== values.contactKey, assignment: { before: existing.exists ? existing.data().assignedUserId ?? null : null, after: assignedUserId } });
    return { customerId };
  });
}

export async function saveSpecialProduct(db, uid, input) {
  if (!text(input?.name, 120) || typeof input.description !== 'string' || input.description.length > 500 || !money(input.finalPricePaise) || typeof input.active !== 'boolean') fail('Special product name, description, final price and status are required.');
  if (!Array.isArray(input.components) || input.components.length < 2 || input.components.length > 4) fail('A special product needs 2 to 4 components.');
  const ids = input.components.map((part) => part.itemId);
  if (new Set(ids).size !== ids.length || input.components.some((part) => !validId(part.itemId) || !validId(part.unitId) || !qty(part.quantityQty, true))) fail('Components need distinct items, units and positive quantities.');
  const specialId = input.specialId || db.collection('specialProducts').doc().id;
  if (!validId(specialId)) fail('Invalid special product ID.');
  const ref = db.doc(`specialProducts/${specialId}`);
  return db.runTransaction(async (tx) => {
    requireStaff(await actor(db, uid, tx));
    const old = await tx.get(ref);
    const itemSnaps = await Promise.all(ids.map((id) => tx.get(db.doc(`items/${id}`))));
    const unitSnaps = await Promise.all(input.components.map((part) => tx.get(db.doc(`units/${part.unitId}`))));
    const components = input.components.map((part, index) => {
      if (!itemSnaps[index].exists || itemSnaps[index].data().active !== true || !unitSnaps[index].exists || part.unitId !== itemSnaps[index].data().defaultUnitId) fail('Each component must use an active item and its default unit.');
      return { itemId: part.itemId, quantityQty: part.quantityQty, unitId: part.unitId, itemSnapshot: itemSnapshot(itemSnaps[index].data(), unitSnaps[index].data()) };
    });
    const values = { name: clean(input.name), description: clean(input.description), finalPricePaise: input.finalPricePaise, active: input.active, components, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdAt: FieldValue.serverTimestamp(), createdBy: uid });
    audit(tx, db, old.exists ? 'special_product.updated' : 'special_product.created', uid, 'specialProduct', specialId, { previousPricePaise: old.exists ? old.data().finalPricePaise : null, finalPricePaise: input.finalPricePaise, active: input.active, previousComponents: old.exists ? old.data().components?.map((part) => ({ itemId: part.itemId, quantityQty: part.quantityQty })) || [] : [], components: components.map((part) => ({ itemId: part.itemId, quantityQty: part.quantityQty })) });
    return { specialId };
  });
}

export function validateOrderInput(input) {
  if (!validDate(input?.orderDate) || input.deliveryDate && (!validDate(input.deliveryDate) || input.deliveryDate < input.orderDate)) fail('Enter a valid order and delivery date.');
  if (typeof input.notes !== 'string' || input.notes.length > 1000) fail('Notes must be 1000 characters or fewer.');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) fail('Add 1 to 20 order lines.');
  for (const line of input.lines) {
    if (!['item', 'special'].includes(line.kind) || !validId(line.productId) || !qty(line.quantityQty, true)) fail('Each line needs a valid product and quantity.');
    if (line.quantityQty % 1000 !== 0) fail('Order quantities must be whole numbers.');
    if (line.unitId !== undefined && (line.kind !== 'item' || !validId(line.unitId))) fail('Choose a valid order unit.');
  }
}

export function validateDistinctOrderLines(lines) {
  const keys = new Set();
  for (const line of lines) {
    const key = `${line.kind}:${line.productId}:${line.kind === 'item' ? line.orderUnitName || 'KG' : 'combo'}`;
    if (keys.has(key)) fail('Combine duplicate order lines with the same unit.');
    keys.add(key);
  }
}

async function buildLines(db, tx, inputs, user) {
  const refs = inputs.map((line) => db.doc(`${line.kind === 'item' ? 'items' : 'specialProducts'}/${line.productId}`));
  const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
  const unitSnaps = await Promise.all(snaps.map((snap, index) => inputs[index].kind === 'item' && snap.exists ? tx.get(db.doc(`units/${snap.data().defaultUnitId}`)) : null));
  const orderUnitSnaps = await Promise.all(inputs.map((line) => line.kind === 'item' && line.unitId && !orderUnitLabel(line.unitId) ? tx.get(db.doc(`units/${line.unitId}`)) : null));
  return inputs.map((line, index) => {
    const snap = snaps[index];
    if (!snap.exists || snap.data().active !== true) fail('An order product is missing or inactive.');
    if (line.kind === 'item') {
      if (!unitSnaps[index]?.exists) fail('Item unit is missing.');
      const selectedUnit = orderUnitSnaps[index];
      const selectedLabel = line.unitId ? orderUnitLabel(line.unitId) || (selectedUnit?.exists && selectedUnit.data().active === true ? orderUnitLabel(selectedUnit.data()) : null) : null;
      if (line.unitId && !selectedLabel) fail('Choose an active order unit.');
      if (selectedLabel === '250 GM' && user.role !== 'admin') fail('Only Admin may select 250 GM.');
      const item = snap.data();
      const configuredPrice = line.unitId === '500gm' ? item.sellingPrice500Gm : line.unitId === '250gm' ? item.sellingPrice250Gm : item.defaultSellingPrice;
      if (['500gm', '250gm'].includes(line.unitId) && configuredPrice === undefined) fail('This item has no price for the selected unit.');
      const unitPricePaise = pricePaise(configuredPrice);
      return { kind: 'item', productId: line.productId, quantityQty: line.quantityQty, ...(line.unitId ? { orderUnitId: line.unitId, orderUnitName: selectedLabel } : {}), unitPricePaise, lineTotalPaise: saleTotal(line.quantityQty, unitPricePaise), itemSnapshot: itemSnapshot(item, unitSnaps[index].data()) };
    }
    if (!Array.isArray(snap.data().components) || snap.data().components.length < 2 || snap.data().components.length > 4 || !money(snap.data().finalPricePaise)) fail('Special product recipe or price is invalid.');
    const unitPricePaise = snap.data().finalPricePaise;
    return { kind: 'special', productId: line.productId, quantityQty: line.quantityQty, unitPricePaise, lineTotalPaise: saleTotal(line.quantityQty, unitPricePaise), specialSnapshot: { name: snap.data().name, finalPricePaise: unitPricePaise, components: snap.data().components } };
  });
}
export function itemStockQuantity(line) {
  const divisor = line.orderUnitName === '500 GM' ? 2 : line.orderUnitName === '250 GM' ? 4 : 1;
  if (line.quantityQty % divisor !== 0) fail('Order quantity is too precise for inventory stock units.');
  return line.quantityQty / divisor;
}
export function requiredStock(lines) {
  const needed = new Map();
  for (const line of lines) {
    if (line.kind === 'item') needed.set(line.productId, (needed.get(line.productId) || 0) + itemStockQuantity(line));
    else for (const part of line.specialSnapshot.components) needed.set(part.itemId, (needed.get(part.itemId) || 0) + part.quantityQty * (line.quantityQty / 1000));
  }
  if ([...needed.values()].some((value) => !qty(value, true))) fail('Required component quantity is invalid.');
  return needed;
}
function orderChanges(before, after) {
  const result = {};
  for (const key of ['orderDate', 'deliveryDate', 'notes', 'grandTotal']) {
    if (before?.[key] !== after[key]) result[key] = { before: before?.[key] ?? null, after: after[key] ?? null };
  }
  const lines = (value) => (value || []).map((line) => ({ kind: line.kind, productId: line.productId, quantityQty: line.quantityQty, ...(line.orderUnitId ? { orderUnitId: line.orderUnitId } : {}), unitPricePaise: line.unitPricePaise }));
  if (JSON.stringify(lines(before?.lines)) !== JSON.stringify(lines(after.lines))) result.lines = { before: lines(before?.lines), after: lines(after.lines) };
  return result;
}

export async function saveOrderDraft(db, uid, input) {
  validateOrderInput(input);
  const orderId = input.orderId || db.collection('orders').doc().id;
  if (!validId(orderId)) fail('Invalid order ID.');
  const ref = db.doc(`orders/${orderId}`);
  const newCustomer = input.newCustomer ? validateCustomer(input.newCustomer) : null;
  if (newCustomer && input.customerId) fail('Select an existing customer or enter a new one.');
  const customerId = newCustomer ? `order_${orderId}` : input.customerId;
  if (!validId(customerId)) fail('Select a customer.');
  const customerRef = db.doc(`customers/${customerId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    const old = await tx.get(ref);
    if (!old.exists) await takingOrders(db, tx);
    if (user.role !== 'admin' && (input.lines.some((line) => line.kind === 'special') || old.exists && old.data().lines?.some((line) => line.kind === 'special'))) fail('Only Admin may create or edit a special order.');
    if (old.exists && !canManage(user, old.data())) fail('You may edit only your own order.');
    if (old.exists) {
      editableOrder(old.data());
      await financialLock(db, tx, orderId);
      if (old.data().status === 'confirmed' && user.role !== 'admin') fail('Only Admin may edit a confirmed order.');
    }
    if (old.exists && newCustomer) fail('New customer must be selected when the order is created.');
    const ownerUid = old.exists ? old.data().ownerUid : user.role === 'admin' ? (input.assignedUserId || uid) : uid;
    if (input.assignedUserId !== undefined && input.assignedUserId !== ownerUid) fail('Order ownership cannot be changed; only Admin may assign a new order.');
    if (!validId(ownerUid)) fail('Assign an active User.');
    const owner = await tx.get(db.doc(`users/${ownerUid}`));
    if (!owner.exists || owner.data().active !== true || !['admin', 'account_admin', 'user'].includes(owner.data().role)) fail('Assign an active OMS account.');
    const customer = await tx.get(customerRef);
    const reservation = newCustomer ? db.doc(`customerContacts/${newCustomer.contactKey}`) : null;
    const duplicate = reservation ? await tx.get(reservation) : null;
    if (newCustomer && (customer.exists || duplicate.exists)) fail('A customer with this contact may already exist. Search before adding a duplicate.');
    if (!newCustomer && !customer.exists) fail('Customer no longer exists.');
    if (old.exists && old.data().customerId !== customerId) fail('Customer cannot be changed after the order is created.');
    if (!newCustomer && !old.exists && !staffRole(user.role) && customer.data().assignedUserId !== uid) fail('Choose a customer assigned to your account.');
    const lines = await buildLines(db, tx, input.lines, user);
    validateDistinctOrderLines(lines);
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal > 1_000_000_000_000) fail('Order total is too large.');
    let initialDeductions = null;
    if (!old.exists || old.data().status === 'draft') {
      const needed = requiredStock(lines);
      const itemIds = [...needed.keys()].sort();
      const itemSnaps = await Promise.all(itemIds.map((itemId) => tx.get(db.doc(`items/${itemId}`))));
      const unitSnaps = await Promise.all(itemSnaps.map((snap) => snap.exists ? tx.get(db.doc(`units/${snap.data().defaultUnitId}`)) : null));
      const stockSnaps = await Promise.all(itemIds.map((itemId) => tx.get(db.doc(`inventory/${itemId}`))));
      initialDeductions = itemIds.map((itemId, index) => {
        const item = itemSnaps[index];
        const state = stockState(stockSnaps[index]);
        if (!item.exists || item.data().active !== true || !unitSnaps[index]?.exists) fail('An order component is inactive or unavailable.');
        if (state.sellingBlocked) fail(`${item.data().name} is blocked from selling.`);
        if (state.onHandQty - state.reservedQty < needed.get(itemId)) fail(`Insufficient available stock for ${item.data().name}.`);
        return { itemId, quantityQty: needed.get(itemId), itemSnapshot: { itemCode: item.data().itemCode, name: item.data().name, unitId: item.data().defaultUnitId, unitSymbol: unitSnaps[index].data().symbol }, state, stockRef: stockSnaps[index].ref };
      });
    }
    let revisedDeductions = null;
    let stockChanges = [];
    if (old.exists && old.data().status !== 'draft') {
      const previous = old.data().stockDeductions;
      if (!Array.isArray(previous) || !previous.length || previous.some((part) => !validId(part.itemId) || !qty(part.quantityQty, true))) fail('Confirmed stock snapshot is missing or invalid.');
      const oldNeeded = new Map(previous.map((part) => [part.itemId, part.quantityQty]));
      const newNeeded = requiredStock(lines);
      const itemIds = [...new Set([...oldNeeded.keys(), ...newNeeded.keys()])].sort();
      const itemSnaps = await Promise.all(itemIds.map((itemId) => tx.get(db.doc(`items/${itemId}`))));
      const unitSnaps = await Promise.all(itemSnaps.map((snap) => snap.exists ? tx.get(db.doc(`units/${snap.data().defaultUnitId}`)) : null));
      const stockSnaps = await Promise.all(itemIds.map((itemId) => tx.get(db.doc(`inventory/${itemId}`))));
      revisedDeductions = itemIds.filter((itemId) => newNeeded.has(itemId)).map((itemId) => {
        const index = itemIds.indexOf(itemId), item = itemSnaps[index], unit = unitSnaps[index];
        if (!item.exists || !unit?.exists || item.data().active !== true) fail('An order component is inactive or unavailable.');
        return { itemId, quantityQty: newNeeded.get(itemId), itemSnapshot: { itemCode: item.data().itemCode, name: item.data().name, unitId: item.data().defaultUnitId, unitSymbol: unit.data().symbol } };
      });
      stockChanges = itemIds.map((itemId, index) => {
        const previousQty = oldNeeded.get(itemId) || 0, nextQty = newNeeded.get(itemId) || 0;
        const difference = previousQty - nextQty, state = stockState(stockSnaps[index]);
        if (difference < 0 && (!itemSnaps[index].exists || itemSnaps[index].data().active !== true || state.sellingBlocked || state.onHandQty - state.reservedQty < -difference)) fail('Insufficient available stock or an item is blocked from selling.');
        if (difference !== 0 && !qty(state.onHandQty + difference)) fail('Stock correction exceeds allowed quantity.');
        const snapshot = revisedDeductions.find((part) => part.itemId === itemId)?.itemSnapshot || previous.find((part) => part.itemId === itemId)?.itemSnapshot;
        return { itemId, difference, state, stockRef: stockSnaps[index].ref, itemSnapshot: snapshot };
      }).filter((part) => part.difference !== 0);
    }
    const counterRef = db.doc(`orderCounters/${input.orderDate.slice(0, 4)}`);
    const counter = old.exists ? null : await tx.get(counterRef);
    const sequence = old.exists ? null : (counter.exists ? counter.data().nextNumber : 1);
    if (!old.exists && (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999)) fail('Order number range is exhausted.');
    const orderNumber = old.exists ? old.data().orderNumber : `SS-${input.orderDate.slice(0, 4)}-${String(sequence).padStart(6, '0')}`;
    const customerData = newCustomer || (old.exists && !staffRole(user.role) && customer.data().assignedUserId !== uid ? old.data().customerSnapshot : customer.data());
    if (newCustomer) {
      tx.create(customerRef, { ...newCustomer, assignedUserId: owner.data().role === 'user' ? ownerUid : null, ownerUserIds: [ownerUid], orderLinks: { [ownerUid]: orderId }, createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.create(reservation, { customerId, createdAt: FieldValue.serverTimestamp() });
      audit(tx, db, 'customer.created', uid, 'customer', customerId);
    } else {
      tx.update(customerRef, { ownerUserIds: [...new Set([...(customer.data().ownerUserIds || []), ownerUid])], orderLinks: { ...(customer.data().orderLinks || {}), [ownerUid]: orderId }, updatedAt: FieldValue.serverTimestamp() });
    }
    if (!old.exists) tx.set(counterRef, { nextNumber: sequence + 1, updatedAt: FieldValue.serverTimestamp() });
    const revision = old.exists ? (old.data().editRevision || 0) + 1 : 0;
    for (const part of stockChanges) {
      setStock(tx, part.stockRef, part.state, part.state.onHandQty + part.difference, uid);
      movement(tx, db, `order_edit_${orderId}_${revision}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_edit_adjustment', part.difference, part.state.onHandQty, 'order', orderId, 'Order edited before invoice', uid, ownerUid, user.name);
    }
    if (!old.exists) for (const part of initialDeductions) {
      setStock(tx, part.stockRef, part.state, part.state.onHandQty - part.quantityQty, uid);
      movement(tx, db, `order_${orderId}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_confirm', -part.quantityQty, part.state.onHandQty, 'order', orderId, 'Order confirmed on creation', uid, ownerUid, user.name);
    }
    const values = { orderNumber, customerId, customerSnapshot: customerSnapshot(customerData), assignedUserId: old.exists ? old.data().assignedUserId || ownerUid : ownerUid, ownerUid, orderDate: input.orderDate, deliveryDate: input.deliveryDate || null, status: old.exists ? old.data().status : 'confirmed', lines, subtotal, grandTotal: subtotal, notes: clean(input.notes), editRevision: revision, ...(!old.exists ? { stockDeductions: initialDeductions.map(({ itemId, quantityQty, itemSnapshot }) => ({ itemId, quantityQty, itemSnapshot })), confirmedAt: FieldValue.serverTimestamp(), confirmedBy: uid } : revisedDeductions ? { stockDeductions: revisedDeductions } : {}), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, old.exists ? 'order.edited' : 'order.created', user, orderId, values, orderChanges(old.exists ? old.data() : null, values));
    if (!old.exists) orderEvent(tx, db, 'order.confirmed', user, orderId, values, { status: { before: null, after: 'confirmed' }, stockDeductions: initialDeductions.map(({ itemId, quantityQty }) => ({ itemId, quantityQty })) });
    return { orderId, orderNumber, customerId, status: values.status };
  });
}

async function confirmDraftInTransaction(db, tx, uid, user, orderId, order) {
    const ref = db.doc(`orders/${orderId}`);
    if (!order.exists || order.data().status !== 'draft') fail('Only a draft order can proceed to confirmation.');
    if (user.role !== 'admin' && order.data().lines?.some((line) => line.kind === 'special')) fail('Only Admin may confirm a special order.');
    if (order.data().archivedAt) fail('Restore this archived order before confirmation.');
    if (!staffRole(user.role) && order.data().ownerUid !== uid) fail('You may confirm only your own order.');
    const original = order.data().lines;
    if (!Array.isArray(original) || original.length < 1 || original.length > 20) fail('Order lines are invalid.');
    const fresh = await buildLines(db, tx, original.map((line) => ({ kind: line.kind, productId: line.productId, quantityQty: line.quantityQty, ...(line.orderUnitId ? { unitId: line.orderUnitId } : {}) })), user);
    const currentSubtotal = fresh.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (currentSubtotal !== order.data().subtotal || fresh.some((line, index) => line.unitPricePaise !== original[index].unitPricePaise || line.kind === 'special' && JSON.stringify(line.specialSnapshot.components) !== JSON.stringify(original[index].specialSnapshot.components))) fail('Product price or recipe changed. Reopen and save the draft before confirmation.');
    const needed = requiredStock(original);
    const itemIds = [...needed.keys()].sort();
    const itemSnaps = await Promise.all(itemIds.map((id) => tx.get(db.doc(`items/${id}`))));
    const unitSnaps = await Promise.all(itemSnaps.map((snap) => snap.exists ? tx.get(db.doc(`units/${snap.data().defaultUnitId}`)) : null));
    const stockSnaps = await Promise.all(itemIds.map((id) => tx.get(db.doc(`inventory/${id}`))));
    const deductions = itemIds.map((itemId, index) => {
      const item = itemSnaps[index];
      const state = stockState(stockSnaps[index]);
      const change = needed.get(itemId);
      if (!item.exists || item.data().active !== true || !unitSnaps[index]?.exists || state.sellingBlocked) fail('An item is inactive, has no unit, or is blocked from selling.');
      if (state.onHandQty - state.reservedQty < change) fail(`Insufficient available stock for ${item.data().name}.`);
      return { itemId, quantityQty: change, itemSnapshot: { itemCode: item.data().itemCode, name: item.data().name, unitId: item.data().defaultUnitId, unitSymbol: unitSnaps[index].data().symbol }, state, stockRef: stockSnaps[index].ref };
    });
    for (const part of deductions) {
      setStock(tx, part.stockRef, part.state, part.state.onHandQty - part.quantityQty, uid);
      movement(tx, db, `order_${orderId}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_confirm', -part.quantityQty, part.state.onHandQty, 'order', orderId, 'Order confirmed', uid, order.data().ownerUid, user.name);
    }
    tx.update(ref, { status: 'confirmed', stockDeductions: deductions.map(({ itemId, quantityQty, itemSnapshot }) => ({ itemId, quantityQty, itemSnapshot })), confirmedAt: FieldValue.serverTimestamp(), confirmedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, 'order.confirmed', user, orderId, order.data(), { status: { before: 'draft', after: 'confirmed' }, stockDeductions: deductions.map(({ itemId, quantityQty }) => ({ itemId, quantityQty })) });
    return { orderId, status: 'confirmed' };
}

export async function confirmOrder(db, uid, orderId) {
  if (!validId(orderId)) fail('Invalid order ID.');
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    await takingOrders(db, tx);
    const order = await tx.get(ref);
    return confirmDraftInTransaction(db, tx, uid, user, orderId, order);
  });
}

export async function cancelOrder(db, uid, orderId, reason) {
  if (!validId(orderId) || !text(reason, 500)) fail('Order and cancellation reason are required.');
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    const order = await tx.get(ref);
    if (!order.exists || !['draft', 'confirmed', 'in_preparation', 'ready'].includes(order.data().status)) fail('This order cannot be cancelled. Delivered orders require a separate return workflow.');
    if (user.role === 'user' && order.data().lines?.some((line) => line.kind === 'special')) fail('Assigned Users may view special orders but cannot change them.');
    if (order.data().paymentRequestedAt) fail('Payment-requested orders cannot use ordinary cancellation.');
    const draft = order.data().status === 'draft';
    if (!staffRole(user.role) && (!draft || order.data().ownerUid !== uid)) fail('Only staff can cancel a confirmed order.');
    const invoice = await tx.get(db.doc(`invoices/${orderId}`));
    if (invoice.exists || order.data().invoiceId || order.data().editLockedAt) fail('An invoiced order needs a credit or return workflow before cancellation.');
    if (!(await tx.get(db.collection('payments').where('orderId', '==', orderId).limit(1))).empty) fail('An order with payment history needs a correction or reversal workflow before cancellation.');
    const deductions = order.data().stockDeductions ?? [];
    const reservations = order.data().stockReservations ?? [];
    if (!Array.isArray(deductions) || !Array.isArray(reservations) || deductions.length && reservations.length || !draft && !deductions.length && !reservations.length) fail('Order stock state needs review before cancellation.');
    const parts = deductions.length ? deductions : reservations;
    if (draft && deductions.length || new Set(parts.map((part) => part?.itemId)).size !== parts.length || parts.some((part) => !validId(part?.itemId) || !qty(part?.quantityQty, true) || !part.itemSnapshot || ['itemCode', 'name', 'unitId', 'unitSymbol'].some((key) => typeof part.itemSnapshot[key] !== 'string'))) fail('Order stock state needs review before cancellation.');
    if (parts.length) {
      const expected = requiredStock(order.data().lines || []);
      if (expected.size !== parts.length || parts.some((part) => expected.get(part.itemId) !== part.quantityQty)) fail('Order stock snapshot does not match its lines. Review before cancellation.');
    }
    const stockSnaps = await Promise.all(parts.map((part) => tx.get(db.doc(`inventory/${part.itemId}`))));
    const inventory = parts.map((part, index) => {
      const snap = stockSnaps[index];
      if (!snap.exists) fail('Inventory record needs review before cancellation.');
      const data = snap.data();
      if (reservations.length) {
        if (!qty(data.onHandQty) || !qty(data.reservedQty) || data.reservedQty > data.onHandQty || data.reservedQty < part.quantityQty) fail('Reserved inventory needs review before cancellation.');
        return { itemId: part.itemId, itemName: part.itemSnapshot.name, unitSymbol: part.itemSnapshot.unitSymbol, reservedQtyReleased: part.quantityQty };
      }
      const state = stockState(snap);
      if (!qty(state.onHandQty + part.quantityQty)) fail('Stock restoration exceeds allowed quantity.');
      return { itemId: part.itemId, itemName: part.itemSnapshot.name, unitSymbol: part.itemSnapshot.unitSymbol, onHandQtyRestored: part.quantityQty };
    });
    parts.forEach((part, index) => {
      const snap = stockSnaps[index];
      if (reservations.length) {
        const state = snap.data();
        tx.update(snap.ref, { reservedQty: state.reservedQty - part.quantityQty, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
        tx.create(db.doc(`inventoryMovements/order_reservation_release_${orderId}_${part.itemId}`), {
          itemId: part.itemId, itemSnapshot: { itemCode: part.itemSnapshot.itemCode, name: part.itemSnapshot.name, unitId: part.itemSnapshot.unitId, unitSymbol: part.itemSnapshot.unitSymbol },
          movementType: 'order_reservation_release', changeQty: 0, previousQty: state.onHandQty, newQty: state.onHandQty,
          reservedChangeQty: -part.quantityQty, previousReservedQty: state.reservedQty, newReservedQty: state.reservedQty - part.quantityQty,
          referenceType: 'order', referenceId: orderId, reason: reason.trim(), actorUid: uid, actorName: user.name, ownerUid: order.data().ownerUid, at: FieldValue.serverTimestamp(),
        });
      } else {
        const state = stockState(snap);
        setStock(tx, snap.ref, state, state.onHandQty + part.quantityQty, uid);
        movement(tx, db, `order_reversal_${orderId}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_reversal', part.quantityQty, state.onHandQty, 'order', orderId, reason.trim(), uid, order.data().ownerUid, user.name);
      }
    });
    tx.update(ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), cancelledBy: uid, cancellationReason: reason.trim(), updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, draft ? 'order.draft_cancelled' : 'order.cancelled', user, orderId, order.data(), { status: { before: order.data().status, after: 'cancelled' }, inventory: { kind: reservations.length ? 'reservation_released' : deductions.length ? 'stock_restored' : 'none', items: inventory } }, reason.trim());
    return { orderId, status: 'cancelled' };
  });
}

export async function advanceOrder(db, uid, orderId, nextStatus) {
  if (!validId(orderId)) fail('Invalid order ID.');
  const transitions = { confirmed: 'in_preparation', in_preparation: 'ready', ready: 'delivered' };
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx); requireStaff(user);
    const order = await tx.get(ref);
    if (!order.exists || transitions[order.data().status] !== nextStatus) fail('Invalid order status transition.');
    if (order.data().archivedAt) fail('Restore this archived order before changing its status.');
    tx.update(ref, { status: nextStatus, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    orderEvent(tx, db, 'order.status_changed', user, orderId, order.data(), { status: { before: order.data().status, after: nextStatus } });
    return { orderId, status: nextStatus };
  });
}

async function changeArchive(db, uid, orderId, archive, reason = '') {
  if (!validId(orderId) || reason && !text(reason, 500)) fail('Order ID or reason is invalid.');
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    const snap = await tx.get(ref);
    if (!snap.exists || !canManage(user, snap.data())) fail('You may manage only your own order.');
    const order = snap.data();
    if (user.role === 'user' && order.lines?.some((line) => line.kind === 'special')) fail('Assigned Users may view special orders but cannot change them.');
    if (!['draft', 'confirmed', 'in_preparation', 'ready'].includes(order.status)) fail('This order status cannot be archived or restored.');
    if (Boolean(order.archivedAt) === archive) fail(archive ? 'Order is already archived.' : 'Order is not archived.');
    if (order.paymentRequestedAt) fail('This order is locked because payment was requested.');
    await financialLock(db, tx, orderId);
    tx.update(ref, archive
      ? { archivedAt: FieldValue.serverTimestamp(), archivedBy: uid, archiveReason: clean(reason), updatedAt: FieldValue.serverTimestamp() }
      : { archivedAt: null, archivedBy: null, restoredAt: FieldValue.serverTimestamp(), restoredBy: uid, updatedAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, archive ? 'order.archived' : 'order.restored', user, orderId, order, { archived: { before: !archive, after: archive } }, clean(reason));
    return { orderId, archived: archive };
  });
}
export const archiveOrder = (db, uid, input) => changeArchive(db, uid, input?.orderId, true, input?.reason);
export const restoreOrder = (db, uid, input) => changeArchive(db, uid, input?.orderId, false);

export async function requestOrderPayment(db, uid, input) {
  if (!validId(input?.orderId)) fail('Order ID is required.');
  const ref = db.doc(`orders/${input.orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    const snap = await tx.get(ref);
    if (!snap.exists || !canManage(user, snap.data())) fail('You may manage only your own order.');
    const order = snap.data();
    if (user.role === 'user' && order.lines?.some((line) => line.kind === 'special')) fail('Assigned Users may view special orders but cannot change them.');
    if (!['confirmed', 'in_preparation', 'ready'].includes(order.status) || order.archivedAt) fail('Only an active confirmed order can request payment.');
    if (order.paymentRequestedAt) fail('Payment has already been requested.');
    if ((await tx.get(db.doc(`invoices/${input.orderId}`))).exists) fail('An invoice already exists for this order. Use the invoice payment workflow.');
    tx.update(ref, { paymentRequestedAt: FieldValue.serverTimestamp(), paymentRequestedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, 'order.payment_requested', user, input.orderId, order, { paymentRequested: { before: false, after: true } });
    return { orderId: input.orderId, paymentRequested: true };
  });
}

export async function setOrderTaking(db, uid, acceptingOrders, reason) {
  if (typeof acceptingOrders !== 'boolean' || !text(reason, 500)) fail('Order-taking status and reason are required.');
  const ref = db.doc('orderControls/global');
  return db.runTransaction(async (tx) => {
    requireStaff(await actor(db, uid, tx));
    const old = await tx.get(ref);
    tx.set(ref, { acceptingOrders, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    audit(tx, db, 'orders.intake_changed', uid, 'orderControls', 'global', { from: old.exists ? old.data().acceptingOrders : true, to: acceptingOrders, reason: reason.trim() });
    return { acceptingOrders };
  });
}

export async function createInvoiceFromOrder(db, uid, orderId) {
  if (!validId(orderId)) fail('Invalid order ID.');
  const invoiceRef = db.doc(`invoices/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    const order = await tx.get(db.doc(`orders/${orderId}`));
    const invoice = await tx.get(invoiceRef);
    if (!order.exists || order.data().status !== 'confirmed') fail('Only a Confirmed order can be invoiced.');
    if (!staffRole(user.role) && order.data().ownerUid !== uid) fail('You may invoice only your own order.');
    if (order.data().archivedAt) fail('Restore this archived order before invoicing.');
    if (invoice.exists) fail('An invoice already exists for this order.');
    const data = order.data();
    if (!Array.isArray(data.stockDeductions) || !data.stockDeductions.length) fail('Confirmed stock snapshot is missing.');
    // Sabha, birth date and customer ownership are deliberately absent.
    const lines = data.lines.map((line) => ({ kind: line.kind, description: line.kind === 'item' ? line.itemSnapshot.name : line.specialSnapshot.name, quantityQty: line.quantityQty, unit: line.kind === 'item' ? line.orderUnitName || line.itemSnapshot.unitSymbol : 'combo', unitPricePaise: line.unitPricePaise, lineTotalPaise: line.lineTotalPaise }));
    tx.create(invoiceRef, { invoiceNumber: `INV-${data.orderNumber}`, orderId, orderNumber: data.orderNumber, ownerUid: data.ownerUid, customerId: data.customerId, customerSnapshot: customerSnapshot(data.customerSnapshot), lines, subtotal: data.subtotal, totalPaise: data.grandTotal, verifiedPaidPaise: 0, paymentStatus: 'unpaid', issuedAt: FieldValue.serverTimestamp(), createdBy: uid, paidAt: null, paidBy: null });
    tx.update(order.ref, { invoiceId: orderId, editLockedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    audit(tx, db, 'invoice.created', uid, 'invoice', orderId, { orderId, totalPaise: data.grandTotal }, user.name);
    orderEvent(tx, db, 'order.invoice_created', user, orderId, data, { invoiceId: { before: null, after: orderId } });
    orderEvent(tx, db, 'order.locked', user, orderId, data, { editLocked: { before: false, after: true } }, 'Invoice created');
    return { invoiceId: orderId };
  });
}
