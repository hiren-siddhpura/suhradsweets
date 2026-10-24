import test from 'node:test';
import assert from 'node:assert/strict';
import { sendUserSetupLink } from '../functions/user-operations.js';

const profiles = {
  admin: { role: 'admin', active: true },
  account: { role: 'account_admin', active: true },
  user: { role: 'user', active: true, email: 'user@example.test' },
  staff: { role: 'admin', active: true, email: 'staff@example.test' },
  inactive: { role: 'user', active: false, email: 'inactive@example.test' },
};
const db = { doc: path => ({ get: async () => {
  const profile = profiles[path.split('/')[1]];
  return { exists: !!profile, data: () => profile };
} }) };
const auth = { getUser: async uid => ({ email: profiles[uid]?.email, disabled: false }) };

test('authorized setup sends the registered Auth email for the selected UID', async () => {
  const old = process.env.AUTH_WEB_API_KEY;
  process.env.AUTH_WEB_API_KEY = 'test-key';
  const calls = [];
  try {
    const result = await sendUserSetupLink(db, 'admin', { targetUid: 'user' }, auth, async (url, options) => {
      calls.push({ url, options }); return { ok: true };
    });
    assert.equal(result.email, 'user@example.test');
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { requestType: 'PASSWORD_RESET', email: 'user@example.test' });
  } finally { if (old === undefined) delete process.env.AUTH_WEB_API_KEY; else process.env.AUTH_WEB_API_KEY = old; }
});

test('ordinary users, inactive targets, and staff targets for Account Admin are rejected', async () => {
  let sent = 0;
  const send = async () => { sent++; return { ok: true }; };
  await assert.rejects(sendUserSetupLink(db, 'user', { targetUid: 'staff' }, auth, send), /access is required/);
  await assert.rejects(sendUserSetupLink(db, 'admin', { targetUid: 'inactive' }, auth, send), /inactive/);
  await assert.rejects(sendUserSetupLink(db, 'account', { targetUid: 'staff' }, auth, send), /Only an Admin/);
  assert.equal(sent, 0);
});
