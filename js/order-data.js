import { collection, doc, getDoc, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const unpack = (snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
export const listOrders = async (db, ownerUid = null) => unpack(await getDocs(ownerUid ? query(collection(db, 'orders'), where('ownerUid', '==', ownerUid)) : collection(db, 'orders')));
export const listCustomers = async (db, ownerUid = null, orders = []) => {
  if (!ownerUid) return unpack(await getDocs(collection(db, 'customers')));
  const ids = [...new Set(orders.map((order) => order.customerId).filter(Boolean))];
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'customers', id))));
  return snaps.filter((snap) => snap.exists()).map((snap) => ({ id: snap.id, ...snap.data() }));
};
export const listOrderProducts = async (db, type, staff) => unpack(await getDocs(staff ? collection(db, type) : query(collection(db, type), where('active', '==', true))));
export const getOrderTaking = async (db) => { const snap = await getDoc(doc(db, 'orderControls', 'global')); return snap.exists() ? snap.data().acceptingOrders !== false : true; };
