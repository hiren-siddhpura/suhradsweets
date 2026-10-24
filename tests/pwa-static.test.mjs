import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));

test('manifest and install icons have required metadata and PNG dimensions', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Suhrad Sweets OMS');
  assert.equal(manifest.short_name, 'Suhrad OMS');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert.ok(icon?.purpose.includes('maskable'));
    const bytes = read(`icons/icon-${size}.png`);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  assert.match(read('index.html').toString(), /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(read('index.html').toString(), /rel="icon"[^>]*href="\/logo\.png"/);
  assert.match(read('index.html').toString(), /class="brand-logo" src="\.\/logo\/suhradsweets\.png"/);
  assert.equal(read('logo.png').readUInt32BE(16), 512);
});

test('service worker caches only public shell assets and never API or invoice data', () => {
  const source = read('sw.js').toString();
  assert.match(source, /request\.mode === 'navigate'/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /STATIC_PATHS\.has\(url\.pathname\)/);
  assert.doesNotMatch(source, /firebase|invoice|customer|payment|caches\.put/);
  assert.ok(existsSync(new URL('offline.html', root)));
});

test('production build includes PWA assets and excludes emulator identifiers', () => {
  for (const path of ['manifest.webmanifest', 'sw.js', 'offline.html', 'logo.png', 'icons/icon-192.png', 'icons/icon-512.png']) assert.ok(existsSync(new URL(`dist/${path}`, root)), path);
  assert.doesNotMatch(read('dist/js/firebase-config.js').toString(), /demo-suh-oms|demo-local-key/);
});

test('core business lists have mobile record containers and responsive card styles', () => {
  const html = read('index.html').toString();
  const css = read('css/styles.css').toString();
  for (const id of ['customer-mobile-list', 'order-mobile-list', 'purchase-mobile-list', 'inventory-mobile-list', 'invoice-mobile-list', 'payment-mobile-list', 'master-mobile-list']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(css, /\.mobile-record-list\{display:none\}/);
  assert.match(css, /\.mobile-table\{display:none\}/);
  assert.match(css, /html,body\{overflow-x:hidden\}/);
});
