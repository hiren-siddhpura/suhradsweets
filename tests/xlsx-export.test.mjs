import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSpreadsheetRows, safeSpreadsheetValue } from '../js/xlsx-export.js';

test('spreadsheet export neutralizes formula-like customer and log fields', () => {
  for (const value of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '  =HYPERLINK("x")', '\t=1']) {
    assert.equal(safeSpreadsheetValue(value), `'${value}`);
  }
  assert.deepEqual(safeSpreadsheetRows([{ Customer: '=BAD()', Amount: 125, Date: '10/10/2026' }]), [{ Customer: "'=BAD()", Amount: 125, Date: '10/10/2026' }]);
});
