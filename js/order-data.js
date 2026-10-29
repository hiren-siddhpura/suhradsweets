import { collection, doc, getDoc, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const unpack = (snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
export const listOrders = async (db, assignedUserId = null) => unpack(await getDocs(assignedUserId ? query(collection(db, 'orders'), where('assignedUserId', '==', assignedUserId)) : collection(db, 'orders')));
export const listCustomers = async (db, ownerUid = null, orders = []) => {
  if (!ownerUid) return unpack(await getDocs(collection(db, 'customers')));
  return unpack(await getDocs(query(collection(db, 'customers'), where('assignedUserId', '==', ownerUid))));
};
export const listOrderProducts = async (db, type, staff) => unpack(await getDocs(staff ? collection(db, type) : query(collection(db, type), where('active', '==', true))));
export const getOrderTaking = async (db) => { const snap = await getDoc(doc(db, 'orderControls', 'global')); return snap.exists() ? snap.data().acceptingOrders !== false : true; };
