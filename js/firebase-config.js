import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { connectAuthEmulator, getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { connectFirestoreEmulator, getFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { connectFunctionsEmulator, getFunctions } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

// Browser-only Firebase web app configuration. Never add service-account credentials here.
const firebaseConfig = {
    apiKey: "AIzaSyBHHkDorVWnOLsehJHIuNl10hum2zfLqQA",
    authDomain: "suhrad-sweets-oms.firebaseapp.com",
    projectId: "suhrad-sweets-oms",
    storageBucket: "suhrad-sweets-oms.firebasestorage.app",
    messagingSenderId: "754303494893",
    appId: "1:754303494893:web:26fcf98c5eac1e8957bae4",
    measurementId: "G-546SF3DW5B"
  };
const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];

export function hasFirebaseConfig() {
  return requiredKeys.every((key) => {
    const value = firebaseConfig[key];
    return typeof value === 'string' && value.trim() && !value.startsWith('YOUR_');
  });
}

export function initializeFirebase() {
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const useEmulators = local && new URLSearchParams(window.location.search).get('firebase') !== 'live';
  if (!useEmulators && !hasFirebaseConfig()) return null;
  const config = useEmulators ? {
    apiKey: 'demo-local-key',
    authDomain: 'demo-suh-oms.firebaseapp.com',
    projectId: 'demo-suh-oms',
    appId: 'demo-local-app',
  } : firebaseConfig;
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, 'us-central1');
  if (useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099');
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  return { app, auth, db, functions, mode: useEmulators ? 'emulator' : 'live' };
}
