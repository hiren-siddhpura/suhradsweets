import { normalizeCustomerContact, validateCustomerInput } from './customer-validation.js';

export const IMPORT_FIELDS = Object.freeze([
  { key: 'fullName', label: 'Customer Name', required: true, aliases: ['customer name', 'name', 'full name'] },
  { key: 'contact', label: 'Phone Number', required: true, aliases: ['phone number', 'phone', 'contact', 'mobile', 'mobile number'] },
  { key: 'area', label: 'Area', required: true, aliases: ['area', 'locality'] },
  { key: 'address', label: 'Address', required: true, aliases: ['address', 'street address'] },
  { key: 'dateOfBirth', label: 'DOB', aliases: ['dob', 'date of birth', 'birth date'] },
  { key: 'sabha', label: 'Sabha Yes/No', aliases: ['sabha', 'sabha yes/no'] },
  { key: 'assignedUser', label: 'Assigned User', aliases: ['assigned user', 'user', 'sales user'] },
]);

const cell = (value) => String(value ?? '').trim();
const headerKey = (value) => cell(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (row.length || value) { row.push(value); rows.push(row); }
  if (!rows.length || rows[0].every((entry) => !cell(entry))) throw new Error('The file needs a header row.');
  return rows;
}

export function workbookSheets(buffer, XLSX) {
  const book = XLSX.read(buffer, { type: 'array', cellText: true, cellDates: false });
  if (!book.SheetNames?.length) throw new Error('The workbook has no sheets.');
  return book.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true }) }));
}

export function suggestMapping(headers) {
  const used = new Set();
  return Object.fromEntries(IMPORT_FIELDS.map((field) => {
    const index = headers.findIndex((header, position) => !used.has(position) && field.aliases.includes(headerKey(header)));
    if (index >= 0) used.add(index);
    return [field.key, index >= 0 ? index : ''];
  }));
}

function sabhaValue(value) {
  const answer = cell(value).toLowerCase();
  if (!answer || ['no', 'n', 'false', '0'].includes(answer)) return false;
  if (['yes', 'y', 'true', '1'].includes(answer)) return true;
  throw new Error('Sabha must be Yes or No.');
}

function assignment(value, activeUsers, defaultUserId) {
  const label = cell(value).toLowerCase();
  if (!label) return defaultUserId || null;
  const matches = activeUsers.filter((user) => [user.displayName, user.fullName, user.email].some((name) => cell(name).toLowerCase() === label));
  if (matches.length !== 1) throw new Error(matches.length ? 'Assigned User matches more than one active user.' : 'Assigned User does not match an active user name or email.');
  return matches[0].id;
}

export function prepareCustomerRows(rows, mapping, activeUsers, defaultUserId = null) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('The file has no customer rows.');
  for (const field of IMPORT_FIELDS.filter((entry) => entry.required)) if (!Number.isInteger(mapping[field.key]) || mapping[field.key] < 0) throw new Error(`Map ${field.label} before previewing.`);
  const selected = Object.values(mapping).filter(Number.isInteger);
  if (new Set(selected).size !== selected.length) throw new Error('Each column can be mapped to only one field.');
  if (defaultUserId && !activeUsers.some((user) => user.id === defaultUserId)) throw new Error('Choose an active default assigned user.');
  const seen = new Map(), prepared = [];
  for (let index = 1; index < rows.length; index++) {
    const raw = rows[index];
    if (!Array.isArray(raw) || raw.every((entry) => !cell(entry))) continue;
    const get = (key) => Number.isInteger(mapping[key]) ? cell(raw[mapping[key]]) : '';
    const entry = { rowNumber: index + 1, status: 'valid', reason: '', input: null, displayName: get('fullName'), displayContact: get('contact') };
    try {
      const input = validateCustomerInput({ fullName: get('fullName'), contact: get('contact'), area: get('area'), address: get('address'), dateOfBirth: get('dateOfBirth') || null, sabha: sabhaValue(get('sabha')) });
      input.assignedUserId = assignment(get('assignedUser'), activeUsers, defaultUserId);
      entry.input = input;
      const contact = normalizeCustomerContact(input.contact);
      if (seen.has(contact)) { entry.status = 'duplicate'; entry.reason = `Same contact as row ${seen.get(contact)}.`; }
      else seen.set(contact, entry.rowNumber);
    } catch (error) { entry.status = 'invalid'; entry.reason = error.message; }
    prepared.push(entry);
  }
  if (prepared.length > 10000) throw new Error('Import at most 10,000 customer rows at a time. Split the file and retry.');
  return prepared;
}

export function importCounts(rows) {
  return { processed: rows.length, imported: rows.filter((row) => row.status === 'imported').length,
    existing: rows.filter((row) => row.status === 'existing').length, duplicate: rows.filter((row) => row.status === 'duplicate').length,
    invalid: rows.filter((row) => row.status === 'invalid').length, failed: rows.filter((row) => row.status === 'failed').length };
}
