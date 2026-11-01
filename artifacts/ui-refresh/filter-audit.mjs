import { writeFileSync } from 'node:fs';
const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
for (const width of [360, 390, 430]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: 'file:///C:/Users/DELL/Desktop/SS/dist/index.html' });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const result = await send('Runtime.evaluate', { expression: `(() => {
    const results = [];
    for (const dock of document.querySelectorAll('.mobile-filter-dock[data-filter-id]')) {
      const trigger = dock?.querySelector('.mobile-filter-trigger');
      if (!trigger) continue;
      trigger.click();
      const sheet = document.querySelector('.mobile-filter-sheet[data-filter-id="' + dock.dataset.filterId + '"]');
      if (!sheet?.open) { results.push({module:dock.closest('.page-view')?.id,open:false}); continue; }
      const fields = [...sheet.querySelectorAll('.mobile-filter-fields > *')];
      const editable = [...sheet.querySelectorAll('select,input[type=date]')].find((field)=>field.tagName === 'SELECT' ? [...field.options].some((option)=>option.value !== field.value) : true);
      const original = editable?.value;
      if (editable) { editable.value = editable.tagName === 'SELECT' ? [...editable.options].find((option)=>option.value !== original).value : '2026-10-01'; editable.dispatchEvent(new Event('change',{bubbles:true})); }
      sheet.querySelector('.mobile-filter-apply').click();
      const applied = !editable || editable.value !== original;
      trigger.click();
      sheet.querySelector('.mobile-filter-clear').click();
      const cleared = !editable || editable.value === original;
      results.push({module:dock.closest('.page-view')?.id,open:true,fields:fields.map((field)=>field.querySelector('input,select')?.id),controls:sheet.querySelectorAll('.mobile-filter-fields input,.mobile-filter-fields select').length,nestedLabels:sheet.querySelectorAll('label label').length,footer:[...sheet.querySelectorAll('.mobile-filter-footer button')].map((b)=>b.textContent.trim()),refreshInDock:!!dock.querySelector('button[id*="refresh"]'),applied,cleared,closed:!sheet.open});
    }
    return JSON.stringify(results);
  })()`, returnByValue: true });
  console.log(width, result.result.result.value);
}
ws.close();
