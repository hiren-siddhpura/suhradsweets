import { writeFileSync } from 'node:fs';
const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 850, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: 'file:///C:/Users/DELL/Desktop/SS/dist/index.html' });
await new Promise((resolve) => setTimeout(resolve, 1800));
await send('Runtime.evaluate', { expression: `(() => { document.querySelector('#workspace-content').hidden=false; for(const page of document.querySelectorAll('.page-view'))page.hidden=page.id!=='orders-view'; for(const id of ['auth-panel','loading-panel','setup-panel','access-panel','error-panel']){const node=document.getElementById(id);if(node)node.hidden=true} const dock=[...document.querySelectorAll('#orders-view .mobile-filter-dock')].find((item)=>document.querySelector('.mobile-filter-sheet[data-filter-id="'+item.dataset.filterId+'"]')?.querySelector('#order-status'));dock?.querySelector('.mobile-filter-trigger')?.click(); return !!dock; })()`, returnByValue: true });
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync('C:/Users/DELL/Desktop/SS/artifacts/ui-refresh/orders-filter-after-390.png', Buffer.from(shot.result.data, 'base64'));
ws.close();


