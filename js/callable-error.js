export function operationErrorCode(error) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  return /^[a-z][a-z-]{0,50}$/.test(code) ? code : 'unknown';
}

export function operationErrorMessage(error, mode = 'unknown') {
  const code = operationErrorCode(error);
  if (code === 'unauthenticated') return 'Your session has expired. Sign in again before saving.';
  if (code === 'permission-denied') return 'Your account does not have permission to perform this action.';
  const genericInternal = code === 'internal' && /^internal(?:\s*\[\d+\])?$/i.test(String(error?.message || '').trim());
  if (code === 'not-found') {
    return mode === 'live'
      ? 'The required Cloud Function is not deployed in us-central1 for the suhrad-sweets-oms project.'
      : 'The required local Cloud Function is not running. Start the Functions emulator and retry.';
  }
  if (genericInternal || ['unavailable', 'deadline-exceeded'].includes(code)) {
    if (mode === 'live') return 'The live backend could not be reached. Check that the required Cloud Function is deployed and your connection is working. Local testing is available in emulator mode.';
    if (mode === 'emulator') return 'The local backend could not be reached. Start the Functions emulator on port 5001, then retry.';
    return 'The trusted backend could not be reached. Check its setup and your connection, then retry.';
  }
  if (code === 'internal' || code === 'unknown') return 'The operation could not be completed. Your data has not been confirmed as saved. Please retry or check the backend logs.';
  return String(error?.message || 'The operation could not be completed.').replace(/^Firebase:\s*/i, '').replace(/\s*\(functions\/[^)]+\)\.?$/, '');
}
