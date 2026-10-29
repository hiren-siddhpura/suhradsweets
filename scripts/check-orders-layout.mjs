import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'suhrad-orders-layout-'));
const screenshot = join(tmpdir(), 'suhrad-orders-layout-390.png');
const port = 9337;
const fixture = join(profile, 'orders-layout-test.html');
const source = await readFile(resolve('dist/index.html'), 'utf8');
const styleUrl = pathToFileURL(resolve('dist/css/styles.css')).href;
await writeFile(fixture, source.replace(/href="\.\/css\/styles\.css[^"]*"/, `href="${styleUrl}"`).replace(/<script type="module" src="[^"]*"><\/script>/, ''), 'utf8');
const url = pathToFileURL(fixture).href;
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', url], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pages = await (await fetch(`http://localhost:${port}/json/list`)).json();
      page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith('file:'));
      if (page) break;
    } catch { /* Browser startup. */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!page) throw new Error('Chrome did not open the built OMS page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (!pending.has(response.id)) return;
    const { done, fail } = pending.get(response.id);
    pending.delete(response.id);
    response.error ? fail(new Error(response.error.message)) : done(response.result);
  });
  const call = (method, params = {}) => new Promise((done, fail) => { const id = ++nextId; pending.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params })); });
  await call('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate('document.readyState') === 'complete') break;
    await new Promise((done) => setTimeout(done, 100));
  }
  await evaluate(`(() => {
    for (const id of ['loading-panel','auth-panel','global-loader']) document.getElementById(id).hidden = true;
    document.getElementById('workspace-content').hidden = false;
    for (const section of document.querySelectorAll('.page-view')) section.hidden = section.id !== 'orders-view';
    document.getElementById('mobile-navigation').hidden = false;
    document.getElementById('order-cards').innerHTML = '<div class="card ops-stat"><span>Visible orders</span><strong>2</strong></div><div class="card ops-stat"><span>Open orders</span><strong>1</strong></div><div class="card ops-stat"><span>Processed value</span><strong>₹715.00</strong></div>';
    document.getElementById('order-body').innerHTML = '<tr><td>SS-2026-000104</td><td>Manshukbhai Patel</td><td>2026-10-29</td><td>Dhruv Gajjar</td><td><span class="order-status-badge is-confirmed">Confirmed</span></td><td>₹1,910.00</td><td class="ops-actions"><button>View</button><button>Edit</button><button>Archive</button><button>Cancel</button><button>Next status</button><button>View invoice</button></td></tr><tr><td>SS-2026-000103</td><td>Sagarbhai Mudaliar</td><td>2026-10-29</td><td>Hem Pandya</td><td><span class="order-status-badge is-confirmed">Confirmed</span></td><td>₹2,360.00</td><td class="ops-actions"><button>View</button><button>Edit</button><button>Archive</button><button>Cancel</button><button>Next status</button><button>Create invoice</button></td></tr>';
    return true;
  })()`);
  const results = [];
  for (const width of [360, 390, 1366]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 761 });
    await new Promise((done) => setTimeout(done, 300));
    const metrics = await evaluate(`(() => {
      const icons = [...document.querySelectorAll('#order-filters svg')].map((icon) => ({ width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height, fill: getComputedStyle(icon).fill }));
      const filters = document.getElementById('order-filters').getBoundingClientRect();
      const table = document.getElementById('order-table-scroll').getBoundingClientRect();
      const nav = document.getElementById('mobile-navigation').getBoundingClientRect();
      const cardHeights = [...document.querySelectorAll('#order-body tr')].map((row) => row.getBoundingClientRect().height);
      const controlsFit = [...document.querySelectorAll('#order-filters input,#order-filters select,#order-filters button')].every((field) => { const box = field.getBoundingClientRect(); return !box.width || box.left >= filters.left - 1 && box.right <= filters.right + 1; });
      window.scrollTo(0, document.documentElement.scrollHeight);
      const pageBottom = document.getElementById('orders-view').getBoundingClientRect().bottom;
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, icons, filters: { width: filters.width, height: filters.height }, tableWidth: table.width, cardHeights, controlsFit, navHeight: nav.height, bottomClearance: nav.top - pageBottom, bottomPadding: getComputedStyle(document.querySelector('.content')).paddingBottom };
    })()`);
    results.push(metrics);
    if (width < 761 && (metrics.pageWidth > width || !metrics.controlsFit || metrics.bottomClearance < 0 || width <= 650 && metrics.cardHeights.some((height) => height > 340) || metrics.icons.some((icon) => icon.width > 20 || icon.height > 20 || icon.fill !== 'none') || metrics.navHeight < 68)) throw new Error(JSON.stringify(metrics));
    if (width === 390) {
      await evaluate('document.getElementById("order-body").scrollIntoView({ block: "start" })');
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
    }
  }
  process.stdout.write(`${JSON.stringify({ results, screenshot })}\n`);
} finally {
  socket?.close();
  browser.kill();
  const target = resolve(profile), base = resolve(tmpdir());
  if (target.startsWith(base + sep)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(target, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) process.stderr.write(`Chrome profile cleanup: ${error.code}\n`); else await new Promise((done) => setTimeout(done, 300)); }
    }
  }
}
