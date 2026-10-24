export function safeSpreadsheetValue(value) {
  if (typeof value !== 'string') return value ?? '';
  // Spreadsheet apps may evaluate cells after opening or re-exporting an XLSX.
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function safeSpreadsheetRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeSpreadsheetValue(value)])));
}

let libraryPromise;
export async function loadSheetJs() {
  if (window.XLSX) return window.XLSX;
  libraryPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('SheetJS could not load. Check your connection.'));
    document.head.append(script);
  });
  return libraryPromise;
}

export async function downloadXlsx(name, sheets) {
  const XLSX = await loadSheetJs();
  const book = XLSX.utils.book_new();
  for (const [title, rows] of sheets) {
    const sheet = XLSX.utils.json_to_sheet(safeSpreadsheetRows(rows));
    XLSX.utils.book_append_sheet(book, sheet, title.slice(0, 31));
  }
  XLSX.writeFile(book, `suhrad-${name}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
