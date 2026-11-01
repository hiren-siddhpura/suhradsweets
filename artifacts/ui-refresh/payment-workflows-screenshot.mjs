import { writeFileSync } from 'node:fs';
const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (pending.has(reply.id)) { pending.get(reply.id)(reply); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
for (const [name, button, width] of [['single-mobile-360', 'payment-create', 360], ['bulk-mobile-360', 'collection-create', 360], ['single-mobile', 'payment-create', 390], ['bulk-mobile', 'collection-create', 390], ['single-mobile-430', 'payment-create', 430], ['bulk-mobile-430', 'collection-create', 430], ['single-desktop', 'payment-create', 1366], ['bulk-desktop', 'collection-create', 1366], ['single-desktop-1920', 'payment-create', 1920], ['bulk-desktop-1920', 'collection-create', 1920]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Page.navigate', { url: 'file:///C:/Users/DELL/Desktop/SS/dist/index.html' });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const state = await send('Runtime.evaluate', { expression: `(() => { document.querySelector('#workspace-content').hidden=false; for(const page of document.querySelectorAll('.page-view'))page.hidden=page.id!=='payments-view'; for(const id of ['auth-panel','loading-panel','setup-panel','access-panel','error-panel']){const node=document.getElementById(id);if(node)node.hidden=true} document.getElementById('${button}')?.click(); return JSON.stringify({dialog:[...document.querySelectorAll('dialog[open]')].map((dialog)=>({label:dialog.getAttribute('aria-label'),text:dialog.textContent.slice(0,140)})),scroll:document.documentElement.scrollWidth,width:innerWidth})})()`, returnByValue: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`C:/Users/DELL/Desktop/SS/artifacts/ui-refresh/${name}.png`, Buffer.from(screenshot.result.data, 'base64'));
  console.log(name, state.result.result.value);
}
ws.close();
