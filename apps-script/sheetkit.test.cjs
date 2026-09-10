const assert = require('node:assert/strict');
const { columnName_, columnIndex_, normalizeWidth_, matchLabel_ } = require('./sheetkit.js');

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

// label matching: prefix/suffix/equals, no accidental match on empty spec.
assert.ok(matchLabel_('7-day aggregate', { prefix: '7-day' }));
assert.ok(matchLabel_('T60 cumulative', { suffix: 'cumulative' }));
assert.ok(matchLabel_('Rank', { equals: 'Rank' }));
assert.ok(!matchLabel_('anything', {}));
assert.ok(!matchLabel_('Rank', { equals: 'Rankk' }));

console.log('sheetkit primitive checks passed.');
