/**
 * sheetkit runtime core — the pieces every compiled bundle needs, independent
 * of which styling features a sheet uses.
 *
 * Holds: A1 helpers, name→index resolution, name-based formula resolution,
 * manual-column preservation, the table writer, the label matcher, gradient
 * run-splitting, the long→grid value builder, and renderTab — a pure dispatcher
 * that runs whatever primitives the compiler wired into SK_RENDER_STEPS.
 *
 * Knows nothing about GA4/Raven/experiments/merchants. Every styling decision is
 * DATA from the manifest tab spec. A new sheet is a new manifest, not new code.
 *
 * The compiler concatenates: core.js + the primitives a manifest actually uses +
 * a generated SK_RENDER_STEPS list + webhook.js + the embedded manifest.
 */

/** A1 column letter from a 1-based column index. columnName_(50) === 'AX'. */
function columnName_(index) {
  var name = '';
  while (index > 0) {
    var rem = (index - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

/** Pad ragged rows to a common width so setValues never throws. */
function normalizeWidth_(values) {
  var width = 1;
  for (var i = 0; i < values.length; i++) width = Math.max(width, values[i].length);
  return values.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
}

/** 1-based column index for a manifest column name, or 0 if absent. */
function columnIndex_(columns, name) {
  for (var i = 0; i < columns.length; i++) {
    if (columns[i].name === name) return i + 1;
  }
  return 0;
}

/**
 * resolveFormula_ turns a name-based formula into a Sheets formula for one data
 * row: each {ColumnName} becomes the A1 cell of that column on `sheetRow`.
 * `=IFERROR({Revenue}/{Sessions},"")` on row 8 → `=IFERROR(AI8/AG8,"")`.
 * Kills the off-by-one A1-letter bug class: mpd never writes A1. Unknown names
 * resolve to #REF! so the sheet flags them loudly.
 */
function resolveFormula_(formula, columns, sheetRow) {
  return formula.replace(/\{([^}]+)\}/g, function (_, name) {
    var idx = columnIndex_(columns, name);
    if (idx === 0) return '#REF!';
    return columnName_(idx) + sheetRow;
  });
}

/**
 * buildGrid_ turns canonical row objects into the 2D display grid plus metadata
 * about non-data rows. It emits: an optional group-header row (2-row headers),
 * the column-name/header row, then one row per record. A record with __section__
 * becomes a merged heading row (text in col 1, rest blank); one with __header__
 * re-emits the column headers (a stacked sub-table); otherwise it's a data row —
 * source_field columns pull the value, formula columns emit a per-row {ColName}→A1
 * formula. Every row occupies one grid slot, so formula A1 resolution stays
 * correct even with headings interspersed.
 *
 * Returns { values, sections, headers } where sections/headers list the 1-based
 * sheet rows of heading / repeated-header rows (+ heading level) for the heading
 * primitive to merge and style.
 */
function buildGrid_(spec, rows) {
  var columns = spec.columns || [];
  var headerRows = spec.header_row || 1;
  var grid = [];
  var sections = [];
  var headers = [];

  // auto_header (default on): emit the group-header + column-name rows at the
  // top. Sheets with headings ABOVE the column header (title/methodology) set
  // auto_header:false and drive the header via a __header__ data row instead.
  if (spec.auto_header !== false) {
    if (headerRows >= 2 && spec.header_merges) {
      var groupRow = columns.map(function () { return ''; });
      spec.header_merges.forEach(function (m) {
        var from = columnIndex_(columns, m.from);
        if (from > 0) groupRow[from - 1] = m.label;
      });
      grid.push(groupRow);
    }
    grid.push(columns.map(function (c) { return c.header != null ? c.header : c.name; }));
  }

  (rows || []).forEach(function (row) {
    if (row && row.__section__ != null) {
      var blank = columns.map(function () { return ''; });
      blank[0] = row.__section__;
      grid.push(blank);
      sections.push({ row: grid.length, level: row.__level || 'section' });
      return;
    }
    if (row && row.__header__) {
      grid.push(columns.map(function (c) { return c.header != null ? c.header : c.name; }));
      headers.push({ row: grid.length });
      return;
    }
    var sheetRow = grid.length + 1;
    grid.push(columns.map(function (c) {
      if (c.formula) return resolveFormula_(c.formula, columns, sheetRow);
      if (c.source_field == null) return '';
      var v = row[c.source_field];
      return v == null ? '' : v;
    }));
  });

  return { values: grid, sections: sections, headers: headers };
}

function rowKeyValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    var month = String(value.getMonth() + 1).padStart(2, '0');
    var day = String(value.getDate()).padStart(2, '0');
    return value.getFullYear() + '-' + month + '-' + day;
  }
  return String(value == null ? '' : value);
}

/** Preserve user-entered columns by a stable row key before replacing a table. */
function preserveValues_(spec, oldValues, newValues) {
  var columns = spec.columns || [];
  var headerRows = spec.header_row || 1;
  var keyIndex = columnIndex_(columns, spec.row_key) - 1;
  var preserved = [];

  columns.forEach(function (column, index) {
    if (column.preserve) preserved.push({ index: index, header: column.header != null ? column.header : column.name });
  });

  if (keyIndex < 0 || !preserved.length || oldValues.length < headerRows) return newValues;

  var keyHeader = columns[keyIndex].header != null ? columns[keyIndex].header : columns[keyIndex].name;
  var oldHeaders = oldValues[headerRows - 1] || [];
  var oldKeyIndex = oldHeaders.indexOf(keyHeader);

  if (oldKeyIndex < 0) return newValues;

  var oldColumns = preserved.map(function (column) {
    return { index: column.index, oldIndex: oldHeaders.indexOf(column.header) };
  }).filter(function (column) { return column.oldIndex >= 0; });
  var byKey = {};

  oldValues.slice(headerRows).forEach(function (row) {
    var key = rowKeyValue_(row[oldKeyIndex]);
    if (!key) return;
    byKey[key] = oldColumns.map(function (column) { return row[column.oldIndex]; });
  });

  return newValues.map(function (row, rowIndex) {
    var copy = row.slice();
    if (rowIndex < headerRows) return copy;
    var key = rowKeyValue_(copy[keyIndex]);
    var old = byKey[key];
    if (!old) return copy;
    oldColumns.forEach(function (column, i) { copy[column.index] = old[i]; });
    return copy;
  });
}

function preserveSheetValues_(sheet, spec, newValues) {
  var columns = spec.columns || [];
  var headerRows = spec.header_row || 1;
  var preserved = columns.filter(function (column) { return column.preserve; });
  var rowCount = Math.max(0, sheet.getLastRow() - headerRows);

  if (!spec.row_key || !preserved.length || !rowCount) return newValues;

  var lastColumn = sheet.getLastColumn();
  var oldHeaders = sheet.getRange(headerRows, 1, 1, lastColumn).getDisplayValues()[0];
  var keyColumn = columns[columnIndex_(columns, spec.row_key) - 1];
  var oldKeyIndex = oldHeaders.indexOf(keyColumn.header != null ? keyColumn.header : keyColumn.name);

  if (oldKeyIndex < 0) return newValues;

  var keys = sheet.getRange(headerRows + 1, oldKeyIndex + 1, rowCount, 1).getDisplayValues();
  var oldValues = [];

  for (var header = 1; header < headerRows; header++) oldValues.push([]);
  oldValues.push(oldHeaders);

  for (var row = 0; row < rowCount; row++) {
    var values = [];
    values[oldKeyIndex] = keys[row][0];
    oldValues.push(values);
  }

  preserved.forEach(function (column) {
    var header = column.header != null ? column.header : column.name;
    var oldIndex = oldHeaders.indexOf(header);
    if (oldIndex < 0) return;
    var values = sheet.getRange(headerRows + 1, oldIndex + 1, rowCount, 1).getValues();
    for (var row = 0; row < rowCount; row++) oldValues[headerRows + row][oldIndex] = values[row][0];
  });

  return preserveValues_(spec, oldValues, newValues);
}

function matchLabel_(label, match) {
  if (!match) return false;
  if (match.empty) return label === '';
  if (match.equals != null) return label === match.equals;
  if (match.prefix != null && label.indexOf(match.prefix) !== 0) return false;
  if (match.suffix != null && label.lastIndexOf(match.suffix) !== label.length - match.suffix.length) return false;
  return match.prefix != null || match.suffix != null;
}

/** Partition a gradient into contiguous row runs when it has a group_by column. */
function gradientRuns_(values, columns, firstDataRow, dataRowCount, groupBy) {
  if (!groupBy) return [{ firstRow: firstDataRow, rowCount: dataRowCount }];

  var groupColumn = columnIndex_(columns, groupBy);
  if (groupColumn < 1) throw new Error('unknown gradient group_by column: ' + groupBy);

  var runs = [];
  var start = firstDataRow;
  var lastGroup;
  for (var offset = 0; offset < dataRowCount; offset++) {
    var row = firstDataRow + offset;
    var group = String((values[row - 1] || [])[groupColumn - 1] || '');
    if (offset > 0 && group !== lastGroup) {
      runs.push({ firstRow: start, rowCount: row - start });
      start = row;
    }
    lastGroup = group;
  }
  if (dataRowCount > 0) runs.push({ firstRow: start, rowCount: firstDataRow + dataRowCount - start });
  return runs;
}

/** Write a fresh table: clear content/format/rules, reset heights, set values. */
function skWriteTable_(sheet, values) {
  var padded = normalizeWidth_(values);
  var width = padded.length ? padded[0].length : 1;
  var resetRows = Math.max(sheet.getLastRow(), padded.length, 1);
  var resetCols = Math.max(sheet.getLastColumn(), width, 1);

  sheet.getRange(1, 1, resetRows, resetCols).breakApart();
  // Reset frozen rows/cols too, so a prior freeze can't block this render's
  // full-width heading merges (Sheets forbids merging across a frozen column).
  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(0);
  sheet.clearContents();
  sheet.getRange(1, 1, resetRows, resetCols).clearFormat();
  sheet.setRowHeights(1, resetRows, 21);
  sheet.setConditionalFormatRules([]);

  if (padded.length) sheet.getRange(1, 1, padded.length, width).setValues(padded);

  return { rows: padded.length, width: width };
}

/**
 * renderTab applies a manifest tab spec to canonical `rows`. It builds the grid
 * (values + heading/header metadata), writes the table, then runs each primitive
 * the compiler wired into SK_RENDER_STEPS. Conditional-format primitives push to
 * ctx.cfRules, installed once at the end. No metric names, no domain branches.
 *
 * Back-compat: if called with a pre-built 2D grid (array of arrays), it renders
 * that directly with no heading metadata.
 */
function renderTab(spreadsheet, spec, rows) {
  var sheet = spreadsheet.getSheetByName(spec.name) || spreadsheet.insertSheet(spec.name);

  var prebuilt = rows.length > 0 && Array.isArray(rows[0]);
  var built = prebuilt ? { values: rows, sections: [], headers: [] } : buildGrid_(spec, rows);

  var values = preserveSheetValues_(sheet, spec, normalizeWidth_(built.values));
  var written = skWriteTable_(sheet, values);
  var headerRows = spec.header_row || 1;

  var ctx = {
    sheet: sheet,
    spec: spec,
    columns: spec.columns || [],
    values: normalizeWidth_(values),
    width: written.width,
    rows: written.rows,
    headerRows: headerRows,
    firstDataRow: headerRows + 1,
    dataRowCount: Math.max(0, written.rows - headerRows),
    sections: built.sections,
    headers: built.headers,
    cfRules: [],
  };

  if (written.rows > 0) {
    for (var i = 0; i < SK_RENDER_STEPS.length; i++) SK_RENDER_STEPS[i](ctx);
    if (ctx.cfRules.length) sheet.setConditionalFormatRules(ctx.cfRules);
  }

  SpreadsheetApp.flush();
  return { sheet: spec.name, rows: written.rows };
}

