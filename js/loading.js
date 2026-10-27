const active = new Map();
let sequence = 0;
let dismissed = false;
const SLOW_MS = 20000;

function render() {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('global-loader');
  if (!overlay) return;
  if (!overlay.dataset?.loadingReady && overlay.addEventListener) {
    overlay.addEventListener('cancel', (event) => event.preventDefault());
    if (overlay.dataset) overlay.dataset.loadingReady = 'true';
  }
  const current = [...active.values()].at(-1);
  const visible = active.size > 0 && !dismissed;
  overlay.hidden = !visible;
  overlay.setAttribute('aria-busy', String(active.size > 0));
  const message = document.getElementById('global-loader-message');
  if (current && message) message.textContent = current.message;
  const slow = document.getElementById('global-loader-slow');
  const dismiss = document.getElementById('global-loader-dismiss');
  if (slow) slow.hidden = !current?.slow;
  if (dismiss) {
    dismiss.hidden = !current?.slow;
    dismiss.onclick = () => { dismissed = true; render(); };
  }
  // A modal dialog enters the top layer, above order and payment dialogs.
  if (overlay.showModal && overlay.close) {
    try {
      if (visible && !overlay.open) overlay.showModal();
      if (!visible && overlay.open) overlay.close();
    } catch { /* Older browsers use the fixed-position fallback. */ }
  }
  document.documentElement.classList.toggle('is-loading', visible);
}

export function startLoading(message = 'Loading…') {
  const token = `loading-${++sequence}`;
  dismissed = false;
  const state = { message, slow: false, timer: null };
  state.timer = setTimeout(() => { state.slow = true; render(); }, SLOW_MS);
  active.set(token, state);
  render();
  return token;
}

export function stopLoading(token) {
  const state = active.get(token);
  if (!state) return;
  clearTimeout(state.timer);
  active.delete(token);
  if (!active.size) dismissed = false;
  render();
}

export function withLoading(task, message) {
  const token = startLoading(message);
  return Promise.resolve().then(task).finally(() => stopLoading(token));
}

// Read-only requests may stop waiting without risking a second write.
export function withReadTimeout(task, milliseconds = 15000, message = 'The request is taking too long.') {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export function loadingCount() { return active.size; }

globalThis.omsLoading = { start: startLoading, stop: stopLoading, withLoading, readTimeout: withReadTimeout, count: loadingCount };
