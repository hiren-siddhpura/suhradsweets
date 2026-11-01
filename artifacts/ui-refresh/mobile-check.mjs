const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
for (const width of [360, 390, 430, 768, 1024, 1366, 1440, 1920]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Page.navigate', { url: 'file:///C:/Users/DELL/Desktop/SS/dist/index.html' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await send('Runtime.evaluate', { expression: `(async () => {
    const results = {};
    for (const [page, selector] of [['orders','.order-filter-form'],['orderAnalytics','.order-analytics-filters'],['payments','.collections-section .ops-toolbar'],['master','.master-filters']]) {
      const view = document.getElementById(page + '-view');
      const toolbar = view?.querySelector(selector);
      const dock = view?.querySelector('.mobile-filter-dock');
      const trigger = dock?.querySelector('.mobile-filter-trigger');
      if (toolbar && trigger && getComputedStyle(trigger).display !== 'none') {
        trigger.click();
        const sheet = view.querySelector('.mobile-filter-sheet');
        const field = sheet?.querySelector('select,input[type=date]');
        let changed = false;
        if (field) { const original = field.value; const option = field.querySelector('option:not([value=""])'); field.value = option?.value || '2026-10-01'; changed = field.value !== original; }
        sheet?.querySelector('.mobile-filter-apply')?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        results[page] = { opens: !!sheet, closedAfterApply: !sheet?.open, changed, scopedFilter: page !== 'payments' || !!view.querySelector('.collections-section #collection-type'), lockedAfterClose: document.documentElement.classList.contains('mobile-filter-open') };
      } else results[page] = { toolbar: !!toolbar, dock: !!dock, trigger: !!trigger };
    }
    return JSON.stringify({ width: innerWidth, scroll: document.documentElement.scrollWidth, results });
  })()`, returnByValue: true, awaitPromise: true });
  console.log(state.result.result.value);
}
ws.close();
