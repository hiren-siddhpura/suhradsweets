import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Keep access in sync with profile changes. No business writes live here yet.
export function observeUserProfile(db, uid, onProfile, onError) {
  return onSnapshot(doc(db, 'users', uid),
    (snapshot) => onProfile(snapshot.exists() ? snapshot.data() : null, snapshot.metadata.fromCache), onError);
}

// Best-effort client event. Rules bind uid to request.auth.uid and at to request.time.
// This is not a tamper-proof audit trail: a client can omit its own event.
export function recordAuthEvent(db, uid, type) {
  if (type !== 'login' && type !== 'logout') throw new Error('Unsupported authentication event');
  return addDoc(collection(db, 'loginLogs'), { uid, type, at: serverTimestamp() });
}
