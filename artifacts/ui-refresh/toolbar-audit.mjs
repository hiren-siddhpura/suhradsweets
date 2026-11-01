const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
for (const width of [360, 390, 430, 1024, 1366, 1920]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Page.navigate', { url: 'file:///C:/Users/DELL/Desktop/SS/dist/index.html' });
  await new Promise((resolve) => setTimeout(resolve, 1250));
  const result = await send('Runtime.evaluate', { expression: `(() => {
    document.querySelector('#workspace-content').hidden=false;
    for (const id of ['auth-panel','loading-panel','setup-panel','access-panel','error-panel']) { const node=document.getElementById(id); if(node)node.hidden=true; }
    const results=[];
    for (const view of document.querySelectorAll('.page-view')) {
      if (!view.querySelector('.mobile-filter-dock')) continue;
      for (const page of document.querySelectorAll('.page-view')) page.hidden=page!==view;
      const docks=[...view.querySelectorAll('.mobile-filter-dock:not([hidden])')];
      for (const dock of docks) {
        const search=dock.querySelector('input[type=search]');
        const searchWidth=search?.getBoundingClientRect().width || 0;
        const applyVisible=[...dock.querySelectorAll('button')].some((button)=>/apply filters/i.test(button.textContent));
        const buttons=[...dock.querySelectorAll('button')].filter((button)=>getComputedStyle(button).display!=='none').map((button)=>button.textContent.trim()||button.getAttribute('aria-label'));
        results.push({module:view.id,searchWidth:Math.round(searchWidth),applyVisible,buttons,dockOverflow:dock.scrollWidth>dock.clientWidth+1});
      }
    }
    return JSON.stringify({width:innerWidth,results});
  })()`, returnByValue: true });
  console.log(result.result.result.value);
}
ws.close();
