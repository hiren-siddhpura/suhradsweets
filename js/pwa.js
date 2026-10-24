export function initPwa() {
  const installButton = document.getElementById('install-app-button');
  const offlineBanner = document.getElementById('offline-banner');
  let installPrompt = null;
  const updateConnection = () => {
    const offline = navigator.onLine === false;
    offlineBanner.hidden = !offline;
    document.getElementById('workspace-content').inert = offline;
    document.querySelectorAll('dialog').forEach((dialog) => { dialog.inert = offline; });
  };
  updateConnection();
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  document.addEventListener('submit', (event) => {
    if (navigator.onLine === false) event.preventDefault();
  }, true);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; installButton.hidden = true; });
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    installButton.hidden = true;
    await prompt.prompt();
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* The live OMS still works without offline shell support. */ });
  }
}
