import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = join(root, `.firebase-user-tests-${randomUUID()}.json`);
writeFileSync(config, JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  functions: { source: 'functions' },
  emulators: { auth: { port: 9199 }, firestore: { port: 8180 }, functions: { port: 5101 }, hub: { port: 4501 }, logging: { port: 4601 }, ui: { enabled: false } },
}));
const env = { ...process.env, OMS_USER_FUNCTIONS_PORT: '5101', OMS_RULES_TEST_PROJECT: 'demo-user-rules-regression' };
delete env.FIREBASE_AUTH_EMULATOR_HOST;
delete env.FIRESTORE_EMULATOR_HOST;
try {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/firebase-tools/lib/bin/firebase.js'),
    'emulators:exec', '--config', config, '--project', 'demo-user-provisioning-tests', '--only', 'auth,firestore,functions',
    'node --test tests/user-operations.test.mjs tests/user-ui.test.mjs tests/master-validation.test.mjs tests/firestore.rules.test.mjs'],
  { cwd: root, env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { unlinkSync(config); }
