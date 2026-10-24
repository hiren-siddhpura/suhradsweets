import test from 'node:test';
import assert from 'node:assert/strict';
import { importCounts, parseCsv, prepareCustomerRows, suggestMapping, workbookSheets } from '../js/customer-import.js';

const users = [{ id: 'userA', displayName: 'Asha Sales', email: 'asha@example.test', active: true, role: 'user' }];
const mapping = { fullName: 0, contact: 1, area: 2, address: 3, dateOfBirth: 4, sabha: 5, assignedUser: 6 };

test('CSV import preserves leading zeros, quotes and country codes', () => {
  const rows = parseCsv('Customer Name,Phone Number,Area,Address,DOB,Sabha Yes/No,Assigned User\r\n"Shah, Asha","09876543210",West,"Main, Road",1990-04-01,Yes,Asha Sales\r\nBela,+919876543210,East,Road,,No,\r\n');
  const prepared = prepareCustomerRows(rows, mapping, users);
  assert.equal(prepared[0].input.contact, '09876543210');
  assert.equal(prepared[0].input.fullName, 'Shah, Asha');
  assert.equal(prepared[0].input.assignedUserId, 'userA');
  assert.equal(prepared[0].input.sabha, true);
  assert.equal(prepared[1].input.contact, '+919876543210');
  assert.equal(prepared[1].input.assignedUserId, null);
});

test('Excel sheet selection and column mapping keep formatted phone text', () => {
  const calls = [];
  const notes = {}, customers = {};
  const XLSX = { read(_buffer, options) { assert.equal(options.cellText, true); return { SheetNames: ['Notes', 'Customers'], Sheets: { Notes: notes, Customers: customers } }; }, utils: { sheet_to_json(sheet, options) { calls.push(options); return sheet === notes ? [] : [['Phone Number', 'Customer Name', 'Address', 'Area'], ['0012345678', 'Asha', 'Road', 'West']]; } } };
  const sheets = workbookSheets(new ArrayBuffer(0), XLSX);
  const selected = sheets[1].rows;
  const proposed = suggestMapping(selected[0]);
  assert.equal(proposed.contact, 0);
  assert.equal(proposed.fullName, 1);
  assert.equal(prepareCustomerRows(selected, proposed, users)[0].input.contact, '0012345678');
  assert.equal(calls[0].raw, false);
});

test('missing fields, duplicate contacts and unknown assignees are reported by row', () => {
  const rows = parseCsv('Name,Phone,Area,Address,DOB,Sabha,Assigned User\nAsha,9876543210,West,Road,,Yes,Asha Sales\nAgain,(987) 654-3210,West,Road,,No,\nMissing,,West,Road,,No,\nUnknown,1111111111,West,Road,,No,not-a-user\n');
  const prepared = prepareCustomerRows(rows, mapping, users);
  assert.deepEqual(prepared.map((row) => row.status), ['valid', 'duplicate', 'invalid', 'invalid']);
  assert.equal(prepared[1].rowNumber, 3);
  assert.match(prepared[1].reason, /row 2/);
  assert.match(prepared[2].reason, /Contact is required/);
  assert.match(prepared[3].reason, /active user/);
  assert.deepEqual(importCounts(prepared), { processed: 4, imported: 0, existing: 0, duplicate: 1, invalid: 2, failed: 0 });
});

test('default assignment requires an active selected user and arbitrary UID text is rejected', () => {
  const rows = parseCsv('Name,Phone,Area,Address,DOB,Sabha,Assigned User\nAsha,9876543210,West,Road,,No,\n');
  assert.equal(prepareCustomerRows(rows, mapping, users, 'userA')[0].input.assignedUserId, 'userA');
  assert.throws(() => prepareCustomerRows(rows, mapping, users, 'inactive'), /active default/);
  rows[1][6] = 'userA';
  assert.equal(prepareCustomerRows(rows, mapping, users)[0].status, 'invalid');
});

test('partial import counts distinguish imported, existing, duplicate, invalid and failed rows', () => {
  const rows = ['imported', 'existing', 'duplicate', 'invalid', 'failed'].map((status, index) => ({ rowNumber: index + 2, status }));
  assert.deepEqual(importCounts(rows), { processed: 5, imported: 1, existing: 1, duplicate: 1, invalid: 1, failed: 1 });
});
