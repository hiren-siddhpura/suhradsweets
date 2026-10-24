// UUID v4 IDs are also used as Firestore document and idempotency keys.
// getRandomValues remains available on browsers that restrict randomUUID to
// secure origins, including an HTTP page opened from a phone on the LAN.
export function uniqueId(source = globalThis.crypto, secureContext = globalThis.isSecureContext) {
  if (secureContext !== false && typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') throw new Error('Secure random IDs are unavailable in this browser.');
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
