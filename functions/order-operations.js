import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { audit, fail, money, movement, qty, setStock, stockState, text, validDate, validId } from './operations.js';

const staffRole = (role) => role === 'admin' || role === 'account_admin';
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
function requireStaff(user) { if (!staffRole(user.role)) fail('Active Admin or Account Admin access is required.'); }
function canManage(user, order) { return staffRole(user.role) || order.ownerUid === user.uid; }
function editableOrder(order) {
  if (!['draft', 'confirmed', 'in_preparation', 'ready'].includes(order.status)) fail('This order status cannot be edited or archived.');
  if (order.archivedAt) fail('Restore this archived order before editing it.');
  if (order.paymentRequestedAt) fail('This order is locked because payment was requested.');
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
async function takingOrders(db, tx) {
  const control = await tx.get(db.doc('orderControls/global'));
  if (control.exists && control.data().acceptingOrders === false) fail('Order-taking is paused.');
}
function validateCustomer(input) {
  if (!text(input?.fullName, 120) || !text(input.contact, 80) || !text(input.address, 300) || !text(input.area, 100)) fail('Customer name, contact, address and area are required.');
  if (input.dateOfBirth && !validDate(input.dateOfBirth)) fail('Enter a valid date of birth.');
  if (typeof input.sabha !== 'boolean') fail('Choose a Sabha value.');
  return { fullName: clean(input.fullName), contact: clean(input.contact), address: clean(input.address), area: clean(input.area), dateOfBirth: input.dateOfBirth || null, sabha: input.sabha, contactKey: contactKey(input.contact) };
}
function customerSnapshot(data) { return { fullName: data.fullName, contact: data.contact, address: data.address, area: data.area }; }
function itemSnapshot(data, unit) { return { itemCode: data.itemCode, name: data.name, unitId: data.defaultUnitId, unitName: unit.name, unitSymbol: unit.symbol }; }

export async function saveCustomer(db, uid, input) {
  const values = validateCustomer(input);
  const customerId = input.customerId || db.collection('customers').doc().id;
  if (!validId(customerId)) fail('Invalid customer ID.');
  const ref = db.doc(`customers/${customerId}`);
  return db.runTransaction(async (tx) => {
    requireStaff(await actor(db, uid, tx));
    const existing = await tx.get(ref);
    const reservation = db.doc(`customerContacts/${values.contactKey}`);
    const reserved = await tx.get(reservation);
    const oldReservation = existing.exists && existing.data().contactKey !== values.contactKey ? db.doc(`customerContacts/${existing.data().contactKey}`) : null;
    const oldReserved = oldReservation ? await tx.get(oldReservation) : null;
    if (reserved.exists && reserved.data().customerId !== customerId) fail('A customer with this contact already exists. Search before adding a duplicate.');
    if (oldReservation && oldReserved.exists && oldReserved.data().customerId === customerId) tx.delete(oldReservation);
    if (!reserved.exists) tx.create(reservation, { customerId, createdAt: FieldValue.serverTimestamp() });
    if (existing.exists) {
      tx.update(ref, { ...values, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    } else {
      tx.create(ref, { ...values, ownerUserIds: [], orderLinks: {}, createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    audit(tx, db, existing.exists ? 'customer.updated' : 'customer.created', uid, 'customer', customerId, { contactChanged: existing.exists && existing.data().contactKey !== values.contactKey });
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

function validateOrderInput(input) {
  if (!validDate(input?.orderDate) || input.deliveryDate && (!validDate(input.deliveryDate) || input.deliveryDate < input.orderDate)) fail('Enter a valid order and delivery date.');
  if (typeof input.notes !== 'string' || input.notes.length > 1000) fail('Notes must be 1000 characters or fewer.');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) fail('Add 1 to 20 order lines.');
  const keys = new Set();
  for (const line of input.lines) {
    if (!['item', 'special'].includes(line.kind) || !validId(line.productId) || !qty(line.quantityQty, true) || line.kind === 'special' && line.quantityQty % 1000 !== 0) fail('Each line needs a valid product and quantity. Special products use whole combos.');
    const key = `${line.kind}:${line.productId}`;
    if (keys.has(key)) fail('Combine duplicate order lines.');
    keys.add(key);
  }
}

async function buildLines(db, tx, inputs) {
  const refs = inputs.map((line) => db.doc(`${line.kind === 'item' ? 'items' : 'specialProducts'}/${line.productId}`));
  const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
  const unitSnaps = await Promise.all(snaps.map((snap, index) => inputs[index].kind === 'item' && snap.exists ? tx.get(db.doc(`units/${snap.data().defaultUnitId}`)) : null));
  return inputs.map((line, index) => {
    const snap = snaps[index];
    if (!snap.exists || snap.data().active !== true) fail('An order product is missing or inactive.');
    if (line.kind === 'item') {
      if (!unitSnaps[index]?.exists) fail('Item unit is missing.');
      const unitPricePaise = pricePaise(snap.data().defaultSellingPrice);
      return { kind: 'item', productId: line.productId, quantityQty: line.quantityQty, unitPricePaise, lineTotalPaise: saleTotal(line.quantityQty, unitPricePaise), itemSnapshot: itemSnapshot(snap.data(), unitSnaps[index].data()) };
    }
    if (!Array.isArray(snap.data().components) || snap.data().components.length < 2 || snap.data().components.length > 4 || !money(snap.data().finalPricePaise)) fail('Special product recipe or price is invalid.');
    const unitPricePaise = snap.data().finalPricePaise;
    return { kind: 'special', productId: line.productId, quantityQty: line.quantityQty, unitPricePaise, lineTotalPaise: saleTotal(line.quantityQty, unitPricePaise), specialSnapshot: { name: snap.data().name, finalPricePaise: unitPricePaise, components: snap.data().components } };
  });
}
function requiredStock(lines) {
  const needed = new Map();
  for (const line of lines) {
    if (line.kind === 'item') needed.set(line.productId, (needed.get(line.productId) || 0) + line.quantityQty);
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
  const lines = (value) => (value || []).map((line) => ({ kind: line.kind, productId: line.productId, quantityQty: line.quantityQty, unitPricePaise: line.unitPricePaise }));
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
    await takingOrders(db, tx);
    const old = await tx.get(ref);
    if (user.role !== 'admin' && (input.lines.some((line) => line.kind === 'special') || old.exists && old.data().lines?.some((line) => line.kind === 'special'))) fail('Only Admin may create or edit a special order.');
    if (old.exists && !canManage(user, old.data())) fail('You may edit only your own order.');
    if (old.exists) { editableOrder(old.data()); await financialLock(db, tx, orderId); }
    if (old.exists && newCustomer) fail('New customer must be selected after the first draft save.');
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
    if (old.exists && old.data().customerId !== customerId) fail('Customer cannot be changed after the draft is created.');
    if (!newCustomer && !staffRole(user.role) && !old.exists) {
      const linkedId = customer.data().orderLinks?.[uid];
      if (!validId(linkedId)) fail('You may use only customers linked to your orders.');
      const linked = await tx.get(db.doc(`orders/${linkedId}`));
      if (!linked.exists || linked.data().ownerUid !== uid || linked.data().customerId !== customerId) fail('Customer link is invalid.');
    }
    const lines = await buildLines(db, tx, input.lines);
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal > 1_000_000_000_000) fail('Order total is too large.');
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
    const customerData = newCustomer || customer.data();
    if (newCustomer) {
      tx.create(customerRef, { ...newCustomer, ownerUserIds: [ownerUid], orderLinks: { [ownerUid]: orderId }, createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.create(reservation, { customerId, createdAt: FieldValue.serverTimestamp() });
      audit(tx, db, 'customer.created', uid, 'customer', customerId);
    } else {
      tx.update(customerRef, { ownerUserIds: [...new Set([...(customerData.ownerUserIds || []), ownerUid])], orderLinks: { ...(customerData.orderLinks || {}), [ownerUid]: orderId }, updatedAt: FieldValue.serverTimestamp() });
    }
    if (!old.exists) tx.set(counterRef, { nextNumber: sequence + 1, updatedAt: FieldValue.serverTimestamp() });
    const revision = old.exists ? (old.data().editRevision || 0) + 1 : 0;
    for (const part of stockChanges) {
      setStock(tx, part.stockRef, part.state, part.state.onHandQty + part.difference, uid);
      movement(tx, db, `order_edit_${orderId}_${revision}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_edit_adjustment', part.difference, part.state.onHandQty, 'order', orderId, 'Order edited before invoice', uid, ownerUid, user.name);
    }
    const values = { orderNumber, customerId, customerSnapshot: customerSnapshot(customerData), assignedUserId: ownerUid, ownerUid, orderDate: input.orderDate, deliveryDate: input.deliveryDate || null, status: old.exists ? old.data().status : 'draft', lines, subtotal, grandTotal: subtotal, notes: clean(input.notes), editRevision: revision, ...(revisedDeductions ? { stockDeductions: revisedDeductions } : {}), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
    if (old.exists) tx.update(ref, values);
    else tx.create(ref, { ...values, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, old.exists ? 'order.edited' : 'order.created', user, orderId, values, orderChanges(old.exists ? old.data() : null, values));
    return { orderId, orderNumber, customerId };
  });
}

export async function confirmOrder(db, uid, orderId) {
  if (!validId(orderId)) fail('Invalid order ID.');
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const user = await actor(db, uid, tx);
    await takingOrders(db, tx);
    const order = await tx.get(ref);
    if (!order.exists || order.data().status !== 'draft') fail('Only a draft order can be confirmed.');
    if (user.role !== 'admin' && order.data().lines?.some((line) => line.kind === 'special')) fail('Only Admin may confirm a special order.');
    if (order.data().archivedAt) fail('Restore this archived order before confirmation.');
    if (!staffRole(user.role) && order.data().ownerUid !== uid) fail('You may confirm only your own order.');
    const original = order.data().lines;
    if (!Array.isArray(original) || original.length < 1 || original.length > 20) fail('Order lines are invalid.');
    const fresh = await buildLines(db, tx, original.map((line) => ({ kind: line.kind, productId: line.productId, quantityQty: line.quantityQty })));
    const currentSubtotal = fresh.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    if (currentSubtotal !== order.data().subtotal || fresh.some((line, index) => line.unitPricePaise !== original[index].unitPricePaise || line.kind === 'special' && JSON.stringify(line.specialSnapshot.components) !== JSON.stringify(original[index].specialSnapshot.components))) fail('Product price or recipe changed. Reopen and save the draft before confirmation.');
    const needed = new Map();
    for (const line of original) {
      if (line.kind === 'item') needed.set(line.productId, (needed.get(line.productId) || 0) + line.quantityQty);
      else for (const part of line.specialSnapshot.components) needed.set(part.itemId, (needed.get(part.itemId) || 0) + part.quantityQty * (line.quantityQty / 1000));
    }
    if ([...needed.values()].some((value) => !qty(value, true))) fail('Required component quantity is invalid.');
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
    if (order.data().archivedAt || order.data().paymentRequestedAt) fail('Archived or payment-requested orders cannot use ordinary cancellation.');
    const draft = order.data().status === 'draft';
    if (!staffRole(user.role) && (!draft || order.data().ownerUid !== uid)) fail('Only staff can cancel a confirmed order.');
    const invoice = await tx.get(db.doc(`invoices/${orderId}`));
    if (invoice.exists) fail('An invoiced order needs a credit or return workflow before cancellation.');
    if (!draft) {
      const deductions = order.data().stockDeductions;
      if (!Array.isArray(deductions) || !deductions.length) fail('Confirmed stock snapshot is missing.');
      const stockSnaps = await Promise.all(deductions.map((part) => tx.get(db.doc(`inventory/${part.itemId}`))));
      deductions.forEach((part, index) => {
        const state = stockState(stockSnaps[index]);
        setStock(tx, stockSnaps[index].ref, state, state.onHandQty + part.quantityQty, uid);
        movement(tx, db, `order_reversal_${orderId}_${part.itemId}`, part.itemId, { ...part.itemSnapshot, defaultUnitId: part.itemSnapshot.unitId }, 'order_reversal', part.quantityQty, state.onHandQty, 'order', orderId, reason.trim(), uid, order.data().ownerUid, user.name);
      });
    }
    tx.update(ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), cancelledBy: uid, cancellationReason: reason.trim(), updatedAt: FieldValue.serverTimestamp() });
    orderEvent(tx, db, draft ? 'order.draft_cancelled' : 'order.cancelled', user, orderId, order.data(), { status: { before: order.data().status, after: 'cancelled' } }, reason.trim());
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
    orderEvent(tx, db, 'order.locked', user, input.orderId, order, { editLocked: { before: false, after: true } }, 'Pre-invoice payment request');
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
    const user = await actor(db, uid, tx); requireStaff(user);
    const order = await tx.get(db.doc(`orders/${orderId}`));
    const invoice = await tx.get(invoiceRef);
    if (!order.exists || !['confirmed', 'in_preparation', 'ready', 'delivered'].includes(order.data().status)) fail('Only a confirmed order can be invoiced.');
    if (order.data().archivedAt) fail('Restore this archived order before invoicing.');
    if (invoice.exists) fail('An invoice already exists for this order.');
    const data = order.data();
    // Sabha, birth date and customer ownership are deliberately absent.
    const lines = data.lines.map((line) => ({ kind: line.kind, description: line.kind === 'item' ? line.itemSnapshot.name : line.specialSnapshot.name, quantityQty: line.quantityQty, unit: line.kind === 'item' ? line.itemSnapshot.unitSymbol : 'combo', unitPricePaise: line.unitPricePaise, lineTotalPaise: line.lineTotalPaise }));
    tx.create(invoiceRef, { invoiceNumber: `INV-${data.orderNumber}`, orderId, orderNumber: data.orderNumber, ownerUid: data.ownerUid, customerId: data.customerId, customerSnapshot: customerSnapshot(data.customerSnapshot), lines, subtotal: data.subtotal, totalPaise: data.grandTotal, verifiedPaidPaise: 0, paymentStatus: 'unpaid', issuedAt: FieldValue.serverTimestamp(), createdBy: uid, paidAt: null, paidBy: null });
    audit(tx, db, 'invoice.created', uid, 'invoice', orderId, { orderId, totalPaise: data.grandTotal }, user.name);
    orderEvent(tx, db, 'order.invoice_created', user, orderId, data, { invoiceId: { before: null, after: orderId } });
    if (!data.paymentRequestedAt) orderEvent(tx, db, 'order.locked', user, orderId, data, { editLocked: { before: false, after: true } }, 'Invoice created');
    return { invoiceId: orderId };
  });
}
