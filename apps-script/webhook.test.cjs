const assert = require('node:assert/strict');
const { rowsToValues_, dataLatestDate_ } = require('./webhook.js');

const spec = {
  name: 'Daily',
  data_key: 'daily',
  columns: [
    { name: 'Date', type: 'date', source_field: 'date' },
    { name: 'Sessions', type: 'integer', source_field: 'sessions' },
    { name: 'RPV', type: 'money', formula: '={Revenue}/{Sessions}' },
  ],
};

// header + source_field mapping; formula column blank for now.
const grid = rowsToValues_(spec, [{ date: '2026-09-01', sessions: 100 }, { date: '2026-09-02', sessions: 120 }]);
assert.deepEqual(grid[0], ['Date', 'Sessions', 'RPV']);
assert.deepEqual(grid[1], ['2026-09-01', 100, '']);
assert.deepEqual(grid[2], ['2026-09-02', 120, '']);

// latest date scan across datasets.
const data = { datasets: { daily: [{ date: '2026-09-01' }, { date: '2026-09-05' }], other: [{ d: '2026-09-09' }] } };
assert.equal(dataLatestDate_(data), '2026-09-09');
assert.equal(dataLatestDate_({ datasets: {} }), '');

console.log('webhook mapping checks passed.');
