import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/firebase-config.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('export function ', 'function ');

function initialize(hostname, port, search, proxy) {
  const connections = [];
  const context = {
    window: { location: { hostname, port, search }, __OMS_LOCAL_EMULATOR_PROXY__: proxy, __OMS_LOCAL_EMULATOR_CONFIG__: { apiKey: 'demo-local-key', authDomain: 'demo-suh-oms.firebaseapp.com', projectId: 'demo-suh-oms', appId: 'demo-local-app' } },
    URLSearchParams,
    initializeApp: options => ({ options }),
    getAuth: app => ({ app }),
    getFirestore: app => ({ app }),
    initializeFirestore: app => ({ app }),
    getFunctions: app => ({ app }),
    connectAuthEmulator: (_auth, url) => connections.push(['auth', url]),
    connectFirestoreEmulator: (_db, host, number) => connections.push(['firestore', host, number]),
    connectFunctionsEmulator: (_functions, host, number) => connections.push(['functions', host, number]),
  };
  vm.runInNewContext(`${source}\nthis.start = initializeFirebase;`, context);
  return { start: context.start, connections };
}

test('LAN development server routes all Firebase services through the local proxy', () => {
  const { start, connections } = initialize('10.59.12.206', '8000', '', true);
  const services = start();
  assert.equal(services.mode, 'emulator');
  assert.equal(services.app.options.projectId, 'demo-suh-oms');
  assert.deepEqual(connections, [
    ['auth', 'http://10.59.12.206:8000'],
    ['firestore', '10.59.12.206', 8000],
    ['functions', '10.59.12.206', 8000],
  ]);
});

test('private LAN access cannot select production Firebase', () => {
  assert.throws(() => initialize('10.59.12.206', '8000', '', false).start(), /Production Firebase is blocked/);
  assert.throws(() => initialize('10.59.12.206', '8000', '?firebase=live', true).start(), /Production Firebase is blocked/);
});

test('explicit localhost live preview remains available', () => {
  const { start, connections } = initialize('localhost', '8000', '?firebase=live', true);
  const services = start();
  assert.equal(services.mode, 'live');
  assert.equal(services.app.options.projectId, 'suhrad-sweets-oms');
  assert.equal(connections.length, 0);
});
