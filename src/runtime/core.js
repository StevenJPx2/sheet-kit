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
    // Optional banner: a merged statement row ABOVE the grouped header. Its text
    // may be a formula, resolved against the first DATA row (header_row + 1) so
    // it can reference a specific data cell (e.g. the cumulative-row p-value).
    if (spec.banner != null) {
      var bannerText = typeof spec.banner === 'string' ? spec.banner : spec.banner.text;
      var bannerVal = (typeof bannerText === 'string' && bannerText.charAt(0) === '=')
        ? resolveFormula_(bannerText, columns, headerRows + 1)
        : bannerText;
      var bannerRow = columns.map(function () { return ''; });
      bannerRow[0] = bannerVal;
      grid.push(bannerRow);
      sections.push({ row: grid.length, level: (typeof spec.banner === 'object' && spec.banner.level) || 'banner' });
    }
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

  var dataStart = grid.length; // grid row of rows[0] is dataStart + 1
  (rows || []).forEach(function (row, idx) {
    if (row && row.__section__ != null) {
      var blank = columns.map(function () { return ''; });
      var text = row.__section__;
      // A section heading may itself be a formula (e.g. a per-block statsig
      // header). Resolve its {Col} refs against this block's next data row — the
      // first following non-heading row (its cumulative row) — so each stacked
      // block reads its OWN cells, not the sheet's first data row.
      if (typeof text === 'string' && text.charAt(0) === '=') {
        var di = idx + 1;
        while (di < rows.length && rows[di] && (rows[di].__section__ != null || rows[di].__header__)) di++;
        text = resolveFormula_(text, columns, dataStart + di + 1);
      }
      blank[0] = text;
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
function skWriteTable_(sheet, values, columns) {
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

  // String columns hold display text ("$2.38", "3.5%"): force them to text
  // format BEFORE setValues so Sheets can't auto-parse them into rounded
  // numbers. Must precede the write — coercion is lossy once it happens.
  (columns || []).forEach(function (c, i) {
    if (c && c.type === "string" && i < width) {
      sheet.getRange(1, i + 1, Math.max(padded.length, 1), 1).setNumberFormat("@");
    }
  });

  if (padded.length) sheet.getRange(1, 1, padded.length, width).setValues(padded);

  return { rows: padded.length, width: width };
}


/** Deterministic string hash (two FNV-1a passes, hex) — pure JS, no Utilities. */
function skHash_(s) {
  var a = 0x811c9dc5, b = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x1000193b) >>> 0;
  }
  return a.toString(16) + b.toString(16);
}

/**
 * layoutSignature_ hashes everything ANY styling primitive could read from the
 * data (spec, grid dims, section/header rows, rowLabel match bitmaps, gradient
 * runs). Cell numbers/text are deliberately excluded. Used as the conservative
 * input hash for a primitive that does not declare its own `inputs`.
 */
function layoutSignature_(spec, values, built, headerRows) {
  var columns = spec.columns || [];
  var width = values.length ? values[0].length : 0;
  var firstDataRow = headerRows + 1;
  var dataRowCount = Math.max(0, values.length - headerRows);

  var labels = (spec.row_label_styles || []).map(function (rule) {
    var name = rule.match && rule.match.column;
    var col = name ? columnIndex_(columns, name) : 1;
    if (col <= 0) col = 1;
    var bits = '';
    for (var i = firstDataRow - 1; i < values.length; i++) {
      bits += matchLabel_(String(values[i][col - 1] || ''), rule.match) ? '1' : '0';
    }
    return bits;
  });
  var runs = (spec.gradients || []).map(function (g) {
    return g.group_by ? gradientRuns_(values, columns, firstDataRow, dataRowCount, g.group_by) : null;
  });

  return skHash_(JSON.stringify({
    spec: spec, rows: values.length, width: width, headerRows: headerRows,
    sections: built.sections, headers: built.headers, labels: labels, runs: runs,
  }));
}

/**
 * renderState_ is what a tab's last render was computed from: its dims plus one
 * input hash per render step. Stored as sheet developer metadata; diffed on the
 * next render to decide which steps must re-run.
 */
var SK_STATE_KEY = 'sk_layout';
var SK_STATE_VERSION = 2;

function renderState_(ctx, built) {
  var fallback = layoutSignature_(ctx.spec, ctx.values, built, ctx.headerRows);
  var steps = {};
  for (var i = 0; i < SK_RENDER_STEPS.length; i++) {
    var step = SK_RENDER_STEPS[i];
    var name = step.name || ('step' + i);
    steps[name] = step.inputs ? skHash_(JSON.stringify(step.inputs(ctx))) : fallback;
  }
  return { v: SK_STATE_VERSION, rows: ctx.rows, width: ctx.width, headerRows: ctx.headerRows, steps: steps };
}

/**
 * diffState_ decides the render plan from the previous and current state.
 * Returns { mode: 'full' | 'values' | 'partial', regions: {format,cf,sheet,chart}, dirty: [names] }.
 *   full    — no/incompatible previous state, or the grid's width / header rows changed
 *             (column positions shift; nothing on the sheet survives).
 *   values  — identical state: only cell contents need writing.
 *   partial — some steps' inputs changed: re-run those regions only. A dirty
 *             step with no declared region forces full (unknown footprint).
 * Pure; unit-tested in the vm sandbox.
 */
function diffState_(prev, cur, regionOf) {
  if (!prev || prev.v !== cur.v || prev.width !== cur.width || prev.headerRows !== cur.headerRows) {
    return { mode: 'full', regions: {}, dirty: [] };
  }
  var dirty = [];
  var regions = {};
  Object.keys(cur.steps).forEach(function (name) {
    if (prev.steps[name] === cur.steps[name]) return;
    var region = regionOf(name);
    if (!region) { regions.__full__ = true; }
    regions[region] = true;
    dirty.push(name);
  });
  if (regions.__full__) return { mode: 'full', regions: {}, dirty: dirty };
  if (!dirty.length && prev.rows === cur.rows) return { mode: 'values', regions: {}, dirty: [] };
  return { mode: 'partial', regions: regions, dirty: dirty };
}

function skReadState_(sheet) {
  var found = sheet.createDeveloperMetadataFinder().withKey(SK_STATE_KEY).find();
  if (!found.length) return null;
  try { return JSON.parse(String(found[0].getValue() || '')); } catch (e) { return null; }
}

function skWriteState_(sheet, state) {
  var json = JSON.stringify(state);
  var found = sheet.createDeveloperMetadataFinder().withKey(SK_STATE_KEY).find();
  if (found.length) found[0].setValue(json);
  else sheet.addDeveloperMetadata(SK_STATE_KEY, json);
}

/** Text-format string columns BEFORE setValues so Sheets can't coerce "$2.38". */
function skTextFormatStrings_(sheet, columns, rows, width) {
  (columns || []).forEach(function (c, i) {
    if (c && c.type === "string" && i < width) sheet.getRange(1, i + 1, Math.max(rows, 1), 1).setNumberFormat("@");
  });
}

/**
 * renderTab applies a manifest tab spec to canonical `rows`. It builds the grid,
 * computes the render state (dims + per-step input hashes), diffs it against the
 * state stored on the sheet, and does the minimum:
 *   values  — setValues only (~1 RPC batch).
 *   partial — setValues + only the dirty regions: `format` steps re-run as a
 *             group behind one clearFormat (they write overlapping cells); `cf`
 *             steps re-run as a group and reinstall the rule set atomically;
 *             `sheet` / `chart` steps re-run individually.
 *   full    — clear everything and run every step (also options.force, or if a
 *             partial write throws — never leave a half-written tab).
 * Google Sheets serializes writes per spreadsheet, so every step skipped here
 * shortens the publish wall-clock 1:1 across all tabs.
 */
function renderTab(spreadsheet, spec, rows, options) {
  options = options || {};
  // A new tab goes at the end of the tab bar, not after whichever tab is active.
  var sheet = spreadsheet.getSheetByName(spec.name) || spreadsheet.insertSheet(spec.name, spreadsheet.getNumSheets());
  var built = buildGrid_(spec, rows);
  var values = normalizeWidth_(preserveSheetValues_(sheet, spec, normalizeWidth_(built.values)));
  var headerRows = spec.header_row || 1;
  var width = values.length ? values[0].length : 1;

  var ctx = {
    sheet: sheet,
    spec: spec,
    columns: spec.columns || [],
    values: values,
    width: width,
    rows: values.length,
    headerRows: headerRows,
    firstDataRow: headerRows + 1,
    dataRowCount: Math.max(0, values.length - headerRows),
    sections: built.sections,
    headers: built.headers,
    cfRules: [],
  };
  var regionOf = function (name) {
    for (var i = 0; i < SK_RENDER_STEPS.length; i++) {
      var s = SK_RENDER_STEPS[i];
      if ((s.name || ('step' + i)) === name) return s.region || null;
    }
    return null;
  };

  var state = renderState_(ctx, built);
  var prev = options.force ? null : skReadState_(sheet);
  var plan = diffState_(prev, state, regionOf);

  if (plan.mode !== 'full' && values.length) {
    try {
      var result = renderPartial_(ctx, prev, plan, options);
      skWriteState_(sheet, state);
      SpreadsheetApp.flush();
      result.sheet = spec.name;
      return result;
    } catch (error) {
      // Fall through to a full render.
    }
  }

  var profile = Boolean(options.profile);
  var timings = {};
  var t0 = Date.now();
  var written = skWriteTable_(sheet, values, spec.columns || []);
  if (profile) { SpreadsheetApp.flush(); timings.writeTable = Date.now() - t0; }

  if (written.rows > 0) {
    for (var i = 0; i < SK_RENDER_STEPS.length; i++) {
      var step = SK_RENDER_STEPS[i];
      var ts = Date.now();
      step(ctx);
      if (profile) { SpreadsheetApp.flush(); timings[step.name || ('step' + i)] = Date.now() - ts; }
    }
    if (ctx.cfRules.length) {
      var tc = Date.now();
      sheet.setConditionalFormatRules(ctx.cfRules);
      if (profile) { SpreadsheetApp.flush(); timings.installCfRules = Date.now() - tc; }
    }
  }

  skWriteState_(sheet, state);
  SpreadsheetApp.flush();
  var full = { sheet: spec.name, rows: written.rows, mode: 'full' };
  if (profile) { timings.total = Date.now() - t0; full.timings = timings; }
  return full;
}

/** The values / partial render. Throws on any Sheets error so the caller can fall back to full. */
function renderPartial_(ctx, prev, plan, options) {
  var sheet = ctx.sheet, values = ctx.values, width = ctx.width, rows = ctx.rows;
  var r = plan.regions;
  var maxRows = Math.max(prev.rows, rows);

  // Rows that vanished: drop their content, formats and merges.
  if (rows < prev.rows) {
    sheet.getRange(rows + 1, 1, prev.rows - rows, width).breakApart().clear();
  }

  if (r.format) {
    // Format steps write overlapping cells (a rowLabel row also carries number
    // formats and bold columns), so the group re-runs from a clean grid. A merge
    // can't span a frozen column: unfreeze first, and re-freeze below.
    // clearFormat() ALSO drops conditional-format rules over the range, so the
    // cf group must reinstall whenever format runs (caught by the parity diff).
    r.cf = true;
    if (ctx.spec.freeze && ctx.spec.freeze.cols) sheet.setFrozenColumns(0);
    sheet.getRange(1, 1, maxRows, width).breakApart().clearFormat();
    sheet.setRowHeights(1, maxRows, 21);
    skTextFormatStrings_(sheet, ctx.columns, rows, width);
  }

  sheet.getRange(1, 1, rows, width).setValues(values);

  var ran = [];
  for (var i = 0; i < SK_RENDER_STEPS.length; i++) {
    var step = SK_RENDER_STEPS[i];
    var name = step.name || ('step' + i);
    var region = step.region;
    var run = (region === 'format' && r.format) || (region === 'cf' && r.cf) ||
      ((region === 'sheet' || region === 'chart') && plan.dirty.indexOf(name) >= 0) ||
      (name === 'sk_freeze_' && r.format && ctx.spec.freeze && ctx.spec.freeze.cols);
    if (!run) continue;
    step(ctx);
    ran.push(name);
  }
  if (r.cf) sheet.setConditionalFormatRules(ctx.cfRules);

  return { rows: rows, mode: ran.length || rows !== prev.rows ? 'partial' : 'values', ran: ran };
}
