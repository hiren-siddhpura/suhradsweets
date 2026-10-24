import { collection, count, doc, documentId, getAggregateFromServer, getCountFromServer, getDoc, getDocs, limit, orderBy, query, startAfter, sum, Timestamp, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { DASHBOARD_TARGET_ID, quantityInKg, summarizeOrderKg, validateTargetKg } from './dashboard-metrics.js';

const row = (snap) => ({ id: snap.id, ...snap.data() });
const dayStart = (day) => Timestamp.fromDate(new Date(`${day}T00:00:00+05:30`));
const nextDay = (day) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };

export async function dashboardOrderKg(db, role, uid, from, to) {
  const terms = [];
  if (from) terms.push(where('orderDate', '>=', from));
  if (to) terms.push(where('orderDate', '<=', to));
  if (role === 'user') terms.push(where('ownerUid', '==', uid));
  const rows = []; let cursor = null;
  do {
    const result = await getDocs(query(collection(db, 'orders'), ...terms, orderBy('orderDate'), ...(cursor ? [startAfter(cursor)] : []), limit(100)));
    rows.push(...result.docs.map(row));
    cursor = result.docs.length === 100 ? result.docs.at(-1) : null;
  } while (cursor);
  return summarizeOrderKg(rows);
}

export async function dashboardTargetKg(db) {
  const snapshot = await getDoc(doc(db, 'settings', DASHBOARD_TARGET_ID));
  if (!snapshot.exists() || snapshot.data().active !== true) return null;
  return Number(validateTargetKg(snapshot.data().value));
}

export async function dashboardStockKg(db, role = 'admin') {
  const items = [], unitCache = new Map(); let cursor = null, totalKg = 0, excludedQuantities = 0;
  const ownableStock = role === 'user';
  do {
    // Users may list active items, then read only those items' inventory documents.
    // They cannot list the inventory collection or read stock for inactive items.
    const result = await getDocs(query(collection(db, ownableStock ? 'items' : 'inventory'),
      ...(ownableStock ? [where('active', '==', true)] : []), orderBy(documentId()),
      ...(cursor ? [startAfter(cursor)] : []), limit(100)));
    const page = await Promise.all(result.docs.map(async (entry) => {
      const item = ownableStock ? entry : await getDoc(doc(db, 'items', entry.id));
      if (!item.exists()) return null;
      const stockDoc = ownableStock ? await getDoc(doc(db, 'inventory', entry.id)) : entry;
      const stock = stockDoc.exists() ? stockDoc.data() : { onHandQty: 0, reservedQty: 0, sellingBlocked: false };
      const data = item.data();
      if (!data.defaultUnitId) return null;
      if (!unitCache.has(data.defaultUnitId)) unitCache.set(data.defaultUnitId, getDoc(doc(db, 'units', data.defaultUnitId)));
      const unit = await unitCache.get(data.defaultUnitId);
      if (!unit.exists() || !Number.isSafeInteger(stock.onHandQty) || !Number.isSafeInteger(stock.reservedQty)) return null;
      const available = stock.sellingBlocked || data.active !== true ? 0 : stock.onHandQty - stock.reservedQty;
      const kg = quantityInKg(available, unit.data().symbol);
      return kg === null ? null : { itemId: entry.id, name: data.name || entry.id, kg, blocked: stock.sellingBlocked === true || data.active !== true };
    }));
    for (const item of page) { if (item) { items.push(item); totalKg += item.kg; } else excludedQuantities++; }
    cursor = result.docs.length === 100 ? result.docs.at(-1) : null;
  } while (cursor);
  return { totalKg, items: items.sort((a, b) => a.name.localeCompare(b.name)), excludedQuantities };
}
const addDate = (filters, field, from, to, timestamp = false) => {
  if (from) filters.push(where(field, '>=', timestamp ? dayStart(from) : from));
  if (to) filters.push(where(field, timestamp ? '<' : '<=', timestamp ? dayStart(nextDay(to)) : to));
};

export function reportConstraints(kind, filters = {}, ownUid = null) {
  const terms = [];
  if (ownUid && ['targets', 'orders', 'invoices', 'payments'].includes(kind)) terms.push(where('ownerUid', '==', ownUid));
  if (kind === 'targets') {
    if (!ownUid && filters.userId) terms.push(where('ownerUid', '==', filters.userId));
    if (filters.periodType) terms.push(where('periodType', '==', filters.periodType));
    if (filters.status) terms.push(where('active', '==', filters.status === 'active'));
    addDate(terms, 'periodStart', filters.from, filters.to);
  }
  if (kind === 'announcements') {
    if (filters.status) terms.push(where('active', '==', filters.status === 'active'));
    if (filters.audience) terms.push(where('audience', '==', filters.audience));
    addDate(terms, 'startsOn', filters.from, filters.to);
    if (filters.search) { terms.push(where('titleKey', '>=', filters.search)); terms.push(where('titleKey', '<=', `${filters.search}\uf8ff`)); }
  }
  if (kind === 'loginLogs') {
    if (filters.userId) terms.push(where('uid', '==', filters.userId));
    if (filters.status) terms.push(where('type', '==', filters.status));
    addDate(terms, 'at', filters.from, filters.to, true);
  }
  if (kind === 'auditLogs') {
    if (filters.userId) terms.push(where('actorUid', '==', filters.userId));
    if (filters.status) terms.push(where('type', '==', filters.status));
    if (filters.entityId) terms.push(where('referenceId', '==', filters.entityId));
    addDate(terms, 'at', filters.from, filters.to, true);
  }
  return terms;
}

export async function reportPage(db, kind, filters = {}, ownUid = null, cursor = null, pageSize = 20) {
  const sortField = { targets: 'periodStart', announcements: filters.search ? 'titleKey' : 'startsOn', loginLogs: 'at', auditLogs: 'at' }[kind];
  if (!sortField) throw new Error('Unknown reporting collection.');
  const terms = reportConstraints(kind, filters, ownUid);
  const q = query(collection(db, kind), ...terms, orderBy(sortField, filters.sort === 'asc' ? 'asc' : 'desc'), ...(cursor ? [startAfter(cursor)] : []), limit(pageSize + 1));
  const result = await getDocs(q);
  const pageDocs = result.docs.slice(0, pageSize);
  return { rows: pageDocs.map(row), cursor: pageDocs.at(-1) || null, hasMore: result.docs.length > pageSize };
}

export async function allReportRows(db, kind, filters = {}, ownUid = null) {
  const rows = []; let cursor = null;
  do {
    const page = await reportPage(db, kind, filters, ownUid, cursor, 100);
    rows.push(...page.rows); cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return rows;
}

export async function activeAnnouncements(db, role, today) {
  const staff = ['admin', 'account_admin'].includes(role);
  const terms = [where('active', '==', true), where('startsOn', '<=', today), where('expiresOn', '>=', today)];
  if (!staff) terms.push(where('audience', 'in', ['all', 'users']));
  const snap = await getDocs(query(collection(db, 'announcements'), ...terms, orderBy('startsOn', 'desc'), limit(20)));
  return snap.docs.map(row);
}

export async function currentTargets(db, ownerUid, today) {
  const snap = await getDocs(query(collection(db, 'targets'), where('ownerUid', '==', ownerUid), where('active', '==', true), where('periodStart', '<=', today), where('periodEnd', '>=', today), orderBy('periodStart', 'desc'), limit(12)));
  return snap.docs.map(row);
}

export async function targetAchievement(db, target) {
  const orders = query(collection(db, 'orders'), where('ownerUid', '==', target.ownerUid), where('status', 'in', ['confirmed', 'in_preparation', 'ready', 'delivered']), where('confirmedAt', '>=', dayStart(target.periodStart)), where('confirmedAt', '<', dayStart(nextDay(target.periodEnd))));
  const result = await getAggregateFromServer(orders, { eligibleSalesPaise: sum('grandTotal') });
  return Number(result.data().eligibleSalesPaise || 0);
}

export async function dashboardTotals(db, role, uid, from, to) {
  const own = role === 'user' ? [where('ownerUid', '==', uid)] : [];
  const orderTerms = [...own, where('orderDate', '>=', from), where('orderDate', '<=', to)];
  const orders = query(collection(db, 'orders'), ...orderTerms);
  const invoices = query(collection(db, 'invoices'), ...own);
  const pending = query(collection(db, 'payments'), ...own, where('verificationStatus', '==', 'unverified'));
  const jobs = {
    orderCount: () => getCountFromServer(orders).then((result) => result.data().count),
    orderValuePaise: () => getAggregateFromServer(orders, { value: sum('grandTotal') }).then((result) => Number(result.data().value || 0)),
    outstandingPaise: async () => {
      const [total, paid] = await Promise.all([
        getAggregateFromServer(invoices, { value: sum('totalPaise') }),
        getAggregateFromServer(invoices, { value: sum('verifiedPaidPaise') }),
      ]);
      return Number(total.data().value || 0) - Number(paid.data().value || 0);
    },
    pendingCount: () => getCountFromServer(pending).then((result) => result.data().count),
  };
  const entries = Object.entries(jobs);
  const results = await Promise.allSettled(entries.map(([, job]) => job()));
  return Object.fromEntries(entries.map(([key], index) => [key, results[index]]));
}

export async function todayOrderCount(db, role, uid, today) {
  const terms = [where('orderDate', '==', today)];
  if (role === 'user') terms.push(where('ownerUid', '==', uid));
  return (await getCountFromServer(query(collection(db, 'orders'), ...terms))).data().count;
}

export async function inventorySummary(db) {
  // Existing inventory documents do not have derived low-stock flags. Reading each
  // item is necessary for an exact comparison with its own threshold.
  let available = 0, blocked = 0, low = 0, cursor = null;
  do {
    const result = await getDocs(query(collection(db, 'inventory'), orderBy(documentId()), ...(cursor ? [startAfter(cursor)] : []), limit(100)));
    for (const snap of result.docs) {
      const value = snap.data(), quantity = Number(value.onHandQty || 0) - Number(value.reservedQty || 0);
      if (value.sellingBlocked === true) blocked++;
      else if (quantity > 0) available++;
      if (quantity <= Number(value.lowStockThresholdQty || 0)) low++;
    }
    cursor = result.docs.length === 100 ? result.docs.at(-1) : null;
  } while (cursor);
  return { available, blocked, low };
}

export async function recentActivity(db, role, uid) {
  if (role === 'user') {
    const snap = await getDocs(query(collection(db, 'orders'), where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(8)));
    return snap.docs.map((entry) => ({ id: entry.id, type: `order.${entry.data().status}`, actorUid: uid, referenceType: 'order', referenceId: entry.id, at: entry.data().updatedAt || entry.data().createdAt }));
  }
  const snap = await getDocs(query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(8)));
  return snap.docs.map(row);
}

export async function reportUsers(db) {
  const snap = await getDocs(query(collection(db, 'users'), orderBy(documentId()), limit(200)));
  return snap.docs.map(row).filter((user) => user.role === 'user')
    .sort((left, right) => (left.displayName || left.fullName || left.id).localeCompare(right.displayName || right.fullName || right.id));
}
