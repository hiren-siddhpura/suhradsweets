const limits = { fullName: 120, contact: 80, area: 100 };
const labels = { fullName: 'Full name', contact: 'Contact', area: 'Area' };

export function validateCustomerInput(input) {
  const result = {};
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof input?.[field] !== 'string' || !input[field].trim()) throw new Error(`${labels[field]} is required.`);
    result[field] = input[field].trim();
    if (result[field].length > limit) throw new Error(`${labels[field]} must be ${limit} characters or fewer.`);
  }
  if (typeof input?.address !== 'string') throw new Error('Address must be text.');
  result.address = input.address.trim();
  if (result.address.length > 300) throw new Error('Address must be 300 characters or fewer.');
  if (!normalizeCustomerContact(result.contact)) throw new Error('Enter a valid contact.');
  const birth = input.dateOfBirth === undefined || input.dateOfBirth === null || input.dateOfBirth === '' ? null : input.dateOfBirth;
  if (birth !== null) {
    const date = typeof birth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? new Date(`${birth}T00:00:00Z`) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== birth) throw new Error('Enter a valid date of birth.');
  }
  return { ...result, dateOfBirth: birth, sabha: input.sabha === true };
}

export function normalizeCustomerContact(contact) {
  return String(contact || '').trim().toLowerCase().replace(/[\s()-]/g, '');
}

export async function customerContactHash(contact) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeCustomerContact(contact)));
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function customerSaveError(error) {
  const code = String(error?.code || '').replace(/^firestore\//, '');
  if (code === 'permission-denied') return 'Firestore denied saving this customer. An active Admin or Account Admin profile and the updated customer Security Rules are required.';
  if (code === 'unauthenticated') return 'Sign in again before saving this customer.';
  if (['unavailable', 'deadline-exceeded'].includes(code)) return 'Firestore could not be reached. Check your connection and retry. The same submission ID will be reused.';
  return error?.message || 'Customer could not be saved. Please retry.';
}
