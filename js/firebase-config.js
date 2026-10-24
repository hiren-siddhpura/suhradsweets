import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { connectAuthEmulator, getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { connectFirestoreEmulator, initializeFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
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
  const localProxy = window.__OMS_LOCAL_EMULATOR_PROXY__ === true;
  const privateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(window.location.hostname);
  const requestedLive = new URLSearchParams(window.location.search).get('firebase') === 'live';
  if (privateLan && (!localProxy || requestedLive)) {
    const error = new Error('Local network access requires the OMS development server in emulator mode. Production Firebase is blocked on this address.');
    error.code = 'local-emulator-required';
    throw error;
  }
  const useEmulators = !requestedLive && localProxy;
  if (!useEmulators && !hasFirebaseConfig()) return null;
  const config = useEmulators ? window.__OMS_LOCAL_EMULATOR_CONFIG__ : firebaseConfig;
  if (useEmulators && !config) throw new Error('Local emulator configuration is missing. Start the OMS development server.');
  const app = initializeApp(config);
  const auth = getAuth(app);
  // Some proxy, antivirus and captive-network implementations break Firestore's
  // default streaming transport and surface only an "unknown" listener error.
  // Long polling keeps the same Auth and Rules enforcement while avoiding that
  // transport incompatibility. Emulators retain their default local transport.
  const db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  });
  const functions = getFunctions(app, 'us-central1');
  if (useEmulators) {
    const emulatorHost = window.location.hostname;
    connectAuthEmulator(auth, `http://${emulatorHost}:${window.location.port}`);
    connectFirestoreEmulator(db, emulatorHost, Number(window.location.port));
    connectFunctionsEmulator(functions, emulatorHost, Number(window.location.port));
  }
  return { app, auth, db, functions, mode: useEmulators ? 'emulator' : 'live' };
}
