const assert = require('node:assert/strict');

// In Apps Script every file shares one global scope. Emulate that for Node by
// hoisting sheetkit's helpers to global before loading webhook.js.
const sheetkit = require('./sheetkit.js');
Object.assign(globalThis, sheetkit);
const { rowsToValues_, dataLatestDate_ } = require('./webhook.js');

const spec = {
  name: 'Daily',
  data_key: 'daily',
  columns: [
    { name: 'Date', type: 'date', source_field: 'date' },
    { name: 'Sessions', type: 'integer', source_field: 'sessions' },
    { name: 'RPV', type: 'money', formula: '={Revenue}/{Sessions}' },
    { name: 'Revenue', type: 'money', source_field: 'revenue' },
  ],
};

// Single-header grid: header row + data rows; formula resolves to A1 for the row.
const grid = rowsToValues_(spec, [
  { date: '2026-09-01', sessions: 100, revenue: 500 },
  { date: '2026-09-02', sessions: 120, revenue: 660 },
]);
assert.deepEqual(grid[0], ['Date', 'Sessions', 'RPV', 'Revenue']);
// row 1 (data) is sheet row 2: RPV = Revenue(col D)/Sessions(col B) → =D2/B2
assert.deepEqual(grid[1], ['2026-09-01', 100, '=D2/B2', 500]);
assert.deepEqual(grid[2], ['2026-09-02', 120, '=D3/B3', 660]);

// Parity check: the old sheet's exact pattern =IFERROR(AI8/AG8,"").
// Build 33 columns so Revenue lands on AI (35) and Sessions on AG (33)… simpler:
// verify IFERROR wrapping + correct A1 on a small spec.
const spec2 = {
  header_row: 1,
  columns: [
    { name: 'C20 RPV', formula: '=IFERROR({C20 Revenue}/{C20 Sessions},"")' },
    { name: 'C20 Sessions', source_field: 'sess' },
    { name: 'C20 Revenue', source_field: 'rev' },
  ],
};
const g2 = rowsToValues_(spec2, [{ sess: 1200, rev: 4380.5 }]);
// data row is sheet row 2; C20 Sessions=col B, C20 Revenue=col C.
assert.equal(g2[1][0], '=IFERROR(C2/B2,"")');

// 2-row grouped header emitted from header_merges labels.
const spec3 = {
  header_row: 2,
  header_merges: [{ from: 'C20 RPV', to: 'T20 RPV', label: 'RPV' }],
  columns: [
    { name: 'C20 RPV', formula: '={C20 Revenue}/{C20 Sessions}' },
    { name: 'T20 RPV', formula: '={C20 Revenue}/{C20 Sessions}' },
    { name: 'C20 Sessions', source_field: 'sess' },
    { name: 'C20 Revenue', source_field: 'rev' },
  ],
};
const g3 = rowsToValues_(spec3, [{ sess: 100, rev: 500 }]);
assert.equal(g3[0][0], 'RPV'); // group-header row, label at 'from' column
assert.equal(g3[1][0], 'C20 RPV'); // column-name row
// data row is sheet row 3 (2 header rows); Sessions=C, Revenue=D
assert.equal(g3[2][0], '=D3/C3');

// unknown column → #REF!
const g4 = rowsToValues_({ columns: [{ name: 'X', formula: '={Nope}' }] }, [{}]);
assert.equal(g4[1][0], '=#REF!');

// latest date scan across datasets (unchanged).
assert.equal(dataLatestDate_({ datasets: { daily: [{ date: '2026-09-01' }, { date: '2026-09-05' }] } }), '2026-09-05');

console.log('webhook formula-generation checks passed.');
