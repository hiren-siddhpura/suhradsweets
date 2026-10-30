import { analyticsXlsxBlob, downloadReportBlob } from './xlsx-export.js';

export async function shareAnalyticsFile(file, { navigator: browser = navigator, download = downloadReportBlob } = {}) {
  let supported = false;
  try { supported = typeof browser.share === 'function' && typeof browser.canShare === 'function' && browser.canShare({ files: [file] }); } catch { /* Use download fallback. */ }
  if (!supported) { download(file, file.name); return 'downloaded'; }
  try {
    // Called synchronously from the Share button, with the file already prepared.
    await browser.share({ files: [file], title: 'Order report', text: 'Hello, please find the order report attached.' });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    throw new Error('Sharing failed. Try again or choose Download Excel and attach the file in WhatsApp.');
  }
}

export async function openAnalyticsExport(workbook, { isAuthorized = () => true } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog analytics-share-dialog';
  dialog.setAttribute('aria-label', 'Export order report');
  dialog.innerHTML = '<h2>Excel order report</h2><p class="analytics-report-name"></p><p role="status" aria-live="polite">Preparing Excel report…</p><div class="analytics-share-actions"><button type="button" class="button button-primary" data-share disabled>Share Excel on WhatsApp</button><button type="button" class="button button-outline" data-download disabled>Download Excel</button><button type="button" class="button button-outline" data-close>Close</button></div>';
  dialog.querySelector('.analytics-report-name').textContent = workbook.filename;
  const status = dialog.querySelector('[role="status"]'), share = dialog.querySelector('[data-share]'), download = dialog.querySelector('[data-download]'), close = dialog.querySelector('[data-close]');
  let file, busy = false;
  const authorized = () => {
    if (isAuthorized()) return true;
    status.textContent = 'Your session changed. Close this report and open it again.';
    share.disabled = download.disabled = true;
    return false;
  };
  const finished = new Promise((resolve) => dialog.addEventListener('close', () => { dialog.remove(); resolve(); }, { once: true }));
  close.onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  download.onclick = () => { if (!busy && file && authorized()) { downloadReportBlob(file, file.name); status.textContent = 'Excel downloaded. Open WhatsApp and attach the downloaded file manually.'; } };
  share.onclick = async () => {
    if (busy || !file || !authorized()) return;
    busy = true; share.disabled = download.disabled = close.disabled = true;
    try {
      const outcome = await shareAnalyticsFile(file);
      status.textContent = outcome === 'downloaded' ? 'File sharing is unavailable in this browser. Excel downloaded. Open WhatsApp, choose a recipient and attach the downloaded file manually.'
        : outcome === 'cancelled' ? 'Sharing cancelled. Your report is ready.' : 'Report handed to the share sheet. Complete sending in the app you selected.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; share.disabled = download.disabled = close.disabled = false; authorized(); }
  };
  document.body.append(dialog); dialog.showModal();
  try {
    const blob = await analyticsXlsxBlob(workbook);
    if (!dialog.isConnected || !authorized()) return finished;
    file = typeof File === 'function' ? new File([blob], workbook.filename, { type: blob.type }) : Object.assign(blob, { name: workbook.filename });
    share.disabled = download.disabled = false;
    status.textContent = 'Ready. Choose Share Excel on WhatsApp, then select WhatsApp and a recipient in your device’s share sheet. If file sharing is unavailable, the report will download.';
  } catch (error) { if (dialog.isConnected) status.textContent = `Could not prepare Excel: ${error.message || 'Please close and try again.'}`; }
  return finished;
}
