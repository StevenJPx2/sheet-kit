const assert = require('node:assert/strict');
const { columnName_, columnIndex_, gradientRuns_, normalizeWidth_, matchLabel_, preserveValues_, rowKeyValue_ } = require('./sheetkit.js');

// A1 resolver — the off-by-one killer.
assert.equal(columnName_(1), 'A');
assert.equal(columnName_(26), 'Z');
assert.equal(columnName_(27), 'AA');
assert.equal(columnName_(50), 'AX');

// name → 1-based index (0 when absent).
const cols = [{ name: 'Date' }, { name: 'Sessions' }, { name: 'RPV' }];
assert.equal(columnIndex_(cols, 'Date'), 1);
assert.equal(columnIndex_(cols, 'RPV'), 3);
assert.equal(columnIndex_(cols, 'Missing'), 0);

// ragged rows padded to common width.
const padded = normalizeWidth_([['a'], ['b', 'c', 'd'], []]);
assert.deepEqual(padded, [['a', '', ''], ['b', 'c', 'd'], ['', '', '']]);

// Gradient groups get independent contiguous percentile ranges.
assert.deepEqual(
  gradientRuns_([
    ['Section', 'Value'],
    ['Previous day', 1],
    ['Previous day', 2],
    ['7-day', 3],
    ['7-day', 4],
  ], [{ name: 'Section' }, { name: 'Value' }], 2, 4, 'Section'),
  [{ firstRow: 2, rowCount: 2 }, { firstRow: 4, rowCount: 2 }],
);

// label matching: prefix/suffix/equals, no accidental match on empty spec.
assert.ok(matchLabel_('7-day aggregate', { prefix: '7-day' }));
assert.ok(matchLabel_('T60 cumulative', { suffix: 'cumulative' }));
assert.ok(matchLabel_('Rank', { equals: 'Rank' }));
assert.ok(!matchLabel_('anything', {}));
assert.ok(!matchLabel_('Rank', { equals: 'Rankk' }));
assert.ok(matchLabel_('', { empty: true }));
assert.ok(!matchLabel_('July cumulative', { empty: true }));

// User-entered columns survive row movement and newly inserted section rows.
const preserveSpec = {
  header_row: 1,
  row_key: 'Date',
  columns: [
    { name: 'Date' },
    { name: 'Value' },
    { name: 'Notes', preserve: true },
  ],
};
const oldValues = [
  ['Date', 'Value', 'Notes'],
  ['2026-09-08', 1, 'deployed'],
  ['2026-09-09', 2, 'campaign'],
];
const newValues = [
  ['Date', 'Value', 'Notes'],
  ['September cumulative', 3, ''],
  ['2026-09-09', 4, ''],
  ['2026-09-08', 5, ''],
];
assert.deepEqual(preserveValues_(preserveSpec, oldValues, newValues), [
  ['Date', 'Value', 'Notes'],
  ['September cumulative', 3, ''],
  ['2026-09-09', 4, 'campaign'],
  ['2026-09-08', 5, 'deployed'],
]);
assert.equal(rowKeyValue_(new Date(2026, 8, 1)), '2026-09-01');

console.log('sheetkit primitive checks passed.');
