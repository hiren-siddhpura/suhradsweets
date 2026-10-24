import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessPage, isStaff, validateProfile } from '../js/permissions.js';

const active = (role) => ({ role, active: true });

test('Admin and Account Admin retain Master Data access; User and invalid roles are denied', () => {
  for (const role of ['admin', 'account_admin']) {
    assert.equal(isStaff(active(role)), true, role);
    assert.equal(canAccessPage(active(role), 'master'), true, role);
  }
  assert.equal(isStaff(active('user')), false);
  assert.equal(canAccessPage(active('user'), 'master'), false);
  assert.equal(validateProfile(active('owner')), 'invalid');
  assert.equal(canAccessPage({ role: 'admin', active: false }, 'master'), false);
});
