import { collection, doc, getDocFromServer, getDocs, getDocsFromServer, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const unpack = (snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
export const listInvoices = async (db, ownerUid) => unpack(await getDocsFromServer(ownerUid ? query(collection(db, 'invoices'), where('ownerUid', '==', ownerUid)) : collection(db, 'invoices')));
export const listPayments = async (db, ownerUid) => unpack(await getDocs(ownerUid ? query(collection(db, 'payments'), where('ownerUid', '==', ownerUid)) : collection(db, 'payments')));
export const listCollections = async (db, ownerUid) => unpack(await getDocs(ownerUid ? query(collection(db, 'collections'), where('ownerUid', '==', ownerUid)) : collection(db, 'collections')));
export const getFreshInvoice = async (db, invoiceId) => { const snap = await getDocFromServer(doc(db, 'invoices', invoiceId)); if (!snap.exists()) throw new Error('Invoice not found or access denied.'); return { id: snap.id, ...snap.data() }; };
