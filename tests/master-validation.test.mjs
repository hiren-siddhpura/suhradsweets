import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDuplicateItemName, normalizeItemCode, validateMasterInput } from '../js/master-validation.js';
import { canAccessPage, canPerform, profileName, validateProfile } from '../js/permissions.js';

test('existing Admin profile with fullName is valid and shown by name', () => {
  const profile = { fullName: 'Suhrad Admin', email: 'admin@example.test', role: 'admin', active: true, createdAt: {} };
  assert.equal(validateProfile(profile), null);
  assert.equal(profileName(profile, { email: 'auth@example.test' }), 'Suhrad Admin');
  assert.equal(validateProfile({ ...profile, active: false }), 'inactive');
  assert.equal(validateProfile({ ...profile, role: 'owner' }), 'invalid');
  assert.equal(validateProfile(null), 'missing');
});

test('item validation normalizes code and rejects invalid prices', () => {
  const item = validateMasterInput('items', {
    itemCode: 'sw-01', name: '  Kaju Katli  ', description: '',
    defaultSellingPrice: '125.50', sellingPrice500Gm: '70.25', sellingPrice250Gm: '40', defaultUnitId: 'unit-1', active: true,
  });
  assert.equal(item.itemCode, 'SW-01');
  assert.equal(item.name, 'Kaju Katli');
  assert.equal(item.defaultSellingPrice, 125.5);
  assert.equal(item.sellingPrice500Gm, 70.25);
  assert.equal(item.sellingPrice250Gm, 40);
  assert.throws(() => validateMasterInput('items', { ...item, sellingPrice250Gm: '-1' }), /250 GM price/);
  assert.equal(validateMasterInput('items', { ...item, defaultSellingPrice: '0.29' }).defaultSellingPrice, 0.29);
  for (const price of ['-1', '1.001', 'abc']) {
    assert.throws(() => validateMasterInput('items', { ...item, defaultSellingPrice: price }), /price/);
  }
  assert.throws(() => normalizeItemCode('bad code'), /Item code/);
  assert.throws(() => validateMasterInput('items', { ...item, itemCode: 'SW-02' }, { existing: item }), /cannot be changed/);
});

test('item names are unique within a stock unit and reusable across units', () => {
  const items = [{ id: 'one', name: 'Kaju Katli', defaultUnitId: 'kg' }];
  assert.equal(hasDuplicateItemName(items, { name: ' kaju katli ', defaultUnitId: 'kg' }), true);
  assert.equal(hasDuplicateItemName(items, { name: 'Kaju Katli', defaultUnitId: '500gm' }), false);
  assert.equal(hasDuplicateItemName(items, { name: 'KAJU KATLI', defaultUnitId: 'kg' }, 'one'), false);
});

test('required fields and staff role assignment are validated', () => {
  assert.throws(() => validateMasterInput('units', { name: ' ', symbol: 'kg', active: true }), /Name is required/);
  assert.throws(() => validateMasterInput('purchaseTypes', { name: 'Local', description: 'x'.repeat(501), active: true }), /Description/);
  assert.throws(() => validateMasterInput('users', { displayName: 'User', role: 'admin', active: true }, { actorRole: 'account_admin' }), /Admin/);
  assert.equal(validateMasterInput('users', { fullName: 'User', email: 'USER@example.test', role: 'user', active: true }, { actorRole: 'account_admin' }).role, 'user');
  assert.equal(validateMasterInput('users', { fullName: 'User', email: 'USER@example.test', role: 'admin', active: true }, { actorRole: 'admin' }).role, 'admin');
  assert.throws(() => validateMasterInput('users', { fullName: 'User', email: 'invalid', role: 'user', active: true }, { actorRole: 'admin' }), /valid email/);
});

test('User navigation and the paid action remain restricted', () => {
  const user = { role: 'user', active: true };
  const admin = { role: 'admin', active: true };
  const account = { role: 'account_admin', active: true };
  assert.equal(canAccessPage(user, 'master'), false);
  assert.equal(canAccessPage(user, 'inventory'), false);
  assert.equal(canAccessPage(user, 'targets'), false);
  assert.equal(canAccessPage(user, 'orders'), true);
  assert.equal(canAccessPage(account, 'inventory'), true);
  assert.equal(canAccessPage(account, 'targets'), true);
  assert.equal(canAccessPage(account, 'master'), true);
  assert.equal(canAccessPage(admin, 'master'), true);
  assert.equal(canPerform(admin, 'markInvoicePaid'), false);
  assert.equal(canPerform(account, 'markInvoicePaid'), true);
  assert.equal(canPerform({ ...account, active: false }, 'manageOperations'), false);
});
