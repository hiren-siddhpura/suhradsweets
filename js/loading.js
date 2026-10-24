const active = new Map();
let sequence = 0;

function render() {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('global-loader');
  if (!overlay) return;
  const current = [...active.values()].at(-1);
  overlay.hidden = active.size === 0;
  overlay.setAttribute('aria-busy', active.size > 0 ? 'true' : 'false');
  if (current) document.getElementById('global-loader-message').textContent = current;
  document.documentElement.classList.toggle('is-loading', active.size > 0);
}

export function startLoading(message = 'Loading…') {
  const token = `loading-${++sequence}`;
  active.set(token, message);
  render();
  return token;
}

export function stopLoading(token) {
  if (!token || !active.delete(token)) return;
  render();
}

export function withLoading(task, message) {
  const token = startLoading(message);
  return Promise.resolve().then(task).finally(() => stopLoading(token));
}

export function loadingCount() { return active.size; }

globalThis.omsLoading = { start: startLoading, stop: stopLoading, withLoading, count: loadingCount };
