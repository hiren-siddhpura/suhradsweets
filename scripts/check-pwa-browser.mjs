import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'suhrad-pwa-'));
const port = 9333;
const standalone = process.argv.includes('--standalone');
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', standalone ? '--app=http://localhost:8000' : 'http://localhost:8000'], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let page;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const pages = await (await fetch(`http://localhost:${port}/json/list`)).json();
      page = pages.find((entry) => entry.type === 'page' && entry.url.includes('localhost:8000'));
      if (page) break;
    } catch { /* Chrome is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!page) throw new Error('Chrome did not open the local OMS page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (!pending.has(response.id)) return;
    const { resolve, reject } = pending.get(response.id);
    pending.delete(response.id);
    if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    const location = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    if (location.result.value?.startsWith('http://localhost:8000/')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await call('Runtime.evaluate', { expression: `(async () => {
    const manifest = await (await fetch('/manifest.webmanifest')).json();
    const icons = await Promise.all(manifest.icons.map(async (icon) => ({ src: icon.src, status: (await fetch(icon.src)).status })));
    const registration = await navigator.serviceWorker.ready;
    return { title: document.title, display: manifest.display, standalone: matchMedia('(display-mode: standalone)').matches, icons, worker: registration.active?.scriptURL, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, offlineBanner: !!document.getElementById('offline-banner') };
  })()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  const data = result.result.value;
  if (data.display !== 'standalone' || data.icons.some((icon) => icon.status !== 200) || !data.worker?.endsWith('/sw.js') || data.documentWidth > data.viewport || !data.offlineBanner || standalone && !data.standalone) throw new Error(JSON.stringify(data));
  await call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  const desktop = await call('Runtime.evaluate', { expression: '({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth })', returnByValue: true });
  if (desktop.result.value.documentWidth > desktop.result.value.viewport) throw new Error(JSON.stringify(desktop.result.value));
  const installability = await call('Page.getInstallabilityErrors');
  await call('Network.enable');
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offline = await call('Runtime.evaluate', { expression: `(() => { window.dispatchEvent(new Event('offline')); return { banner: !document.getElementById('offline-banner').hidden, workspaceInert: document.getElementById('workspace-content').inert }; })()`, returnByValue: true });
  await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  if (!offline.result.value.banner || !offline.result.value.workspaceInert) throw new Error(JSON.stringify(offline.result.value));
  process.stdout.write(`${JSON.stringify({ mobile: data, desktop: desktop.result.value, offline: offline.result.value, installabilityErrors: installability.installabilityErrors })}\n`);
} finally {
  socket?.close();
  browser.kill();
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) process.stderr.write(`Temporary Chrome profile cleanup: ${error.code}\n`); else await new Promise((resolveWait) => setTimeout(resolveWait, 300)); }
    }
  }
}
