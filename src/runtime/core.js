/**
 * sheetkit runtime core — the Apps Script half of every compiled bundle,
 * independent of which styling features a sheet uses.
 *
 * Holds: the SpreadsheetApp side of preservation, the table writer, the render
 * state (incremental values/partial modes) and renderTab — a dispatcher that
 * runs whatever primitives the compiler wired into SK_RENDER_STEPS. The pure
 * layout logic (A1 helpers, formula resolution, buildGrid_, preserveValues_,
 * gradient runs, …) lives in grid.js, shared with the Sheets API renderer.
 *
 * Knows nothing about GA4/Raven/experiments/merchants. Every styling decision is
 * DATA from the manifest tab spec. A new sheet is a new manifest, not new code.
 *
 * The compiler concatenates: grid.js (exports stripped) + core.js + the
 * primitives a manifest actually uses + a generated SK_RENDER_STEPS list +
 * webhook.js + the embedded manifest.
 */

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
