import { onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

export function sendUserSetupEmail(auth, email) {
  return sendPasswordResetEmail(auth, email);
}

export function observeAuth(auth, onUser, onError) {
  return onAuthStateChanged(auth, onUser, onError);
}

export function signIn(auth, email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser(auth) {
  return signOut(auth);
}
