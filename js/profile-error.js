export function firebaseErrorCode(error) {
  const code = String(error?.code || '').replace(/^firestore\//, '');
  return /^[a-z][a-z0-9/-]{0,79}$/.test(code) ? code : 'unknown';
}

export function profileReadErrorMessage(error, emulatorMode) {
  const code = firebaseErrorCode(error);
  if (code === 'permission-denied') {
    return `Firebase sign-in succeeded, but Firestore denied reading your users/{Auth UID} profile. ${emulatorMode ? 'Check the emulator Rules and that the Auth and Firestore emulators use the same demo project.' : 'Check the published Firestore Rules and that the profile document ID equals your Authentication UID.'}`;
  }
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return emulatorMode
      ? 'The Firestore emulator could not be reached at 127.0.0.1:8080. Start the Firebase Emulator Suite, then reload.'
      : 'Firestore could not be reached. Check your network connection and reload.';
  }
  return 'Your OMS profile could not be verified. Check your connection and Firestore Rules, then reload.';
}
