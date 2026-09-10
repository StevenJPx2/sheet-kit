/**
 * sheetkit — generic, domain-agnostic Google Sheets rendering primitives.
 *
 * Knows nothing about GA4, Raven, experiments, RPV, "Top Products", PASS/FAIL,
 * or any merchant. Every styling decision is DATA, supplied by the manifest tab
 * spec. A new sheet is a new manifest, not new code.
 *
 * Entry point: renderTab(spreadsheet, tabSpec, values)
 *   tabSpec — one manifest.tabs[] entry (see contract/manifest.schema.json)
 *   values  — 2D array of display strings (already composed by `data`)
 *
 * Primitives are exported on the global so per-report escape hatches (if ever
 * added) and tests can call them directly.
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
 * This is what kills the off-by-one A1-letter bug class: mpd never writes A1.
 * An unknown column name resolves to #REF! so the sheet flags it loudly.
 */
function resolveFormula_(formula, columns, sheetRow) {
  return formula.replace(/\{([^}]+)\}/g, function (_, name) {
    var idx = columnIndex_(columns, name);
    if (idx === 0) return '#REF!';
    return columnName_(idx) + sheetRow;
  });
}

// --- primitives -------------------------------------------------------------

function skWriteTable_(sheet, values) {
  var padded = normalizeWidth_(values);
  var width = padded.length ? padded[0].length : 1;
  var resetRows = Math.max(sheet.getLastRow(), padded.length, 1);
  var resetCols = Math.max(sheet.getLastColumn(), width, 1);
  sheet.getRange(1, 1, resetRows, resetCols).breakApart();
  sheet.clearContents();
  sheet.setConditionalFormatRules([]);
  if (padded.length) sheet.getRange(1, 1, padded.length, width).setValues(padded);
  return { rows: padded.length, width: width };
}

/** Merge contiguous header groups. merges: [{from,to,label}] resolved by A1 or col name is done by caller; here from/to are 1-based columns on `row`. */
function skMergeHeader_(sheet, row, merges) {
  (merges || []).forEach(function (m) {
    if (m.to > m.from) sheet.getRange(row, m.from, 1, m.to - m.from + 1).merge();
  });
}

function skFreeze_(sheet, freeze) {
  if (!freeze) return;
  if (freeze.rows) sheet.setFrozenRows(freeze.rows);
  if (freeze.cols) sheet.setFrozenColumns(freeze.cols);
}

/** numberFormats: [{column, format, firstRow, rowCount}] — column is 1-based. */
function skNumberFormats_(sheet, formats) {
  (formats || []).forEach(function (f) {
    if (f.rowCount > 0) sheet.getRange(f.firstRow, f.column, f.rowCount, 1).setNumberFormat(f.format);
  });
}

/** columnWidths: [{column, width}] — column 1-based. */
function skColumnWidths_(sheet, widths) {
  (widths || []).forEach(function (w) { sheet.setColumnWidth(w.column, w.width); });
}

var SK_INTERP = { number: 'NUMBER', percent: 'PERCENT', percentile: 'PERCENTILE', min: 'MIN', max: 'MAX' };

/** Build one percentile/number gradient rule over a column range. */
function skGradientRule_(sheet, g) {
  var range = sheet.getRange(g.firstRow, g.column, g.rowCount, 1);
  var b = SpreadsheetApp.newConditionalFormatRule();
  var interp = SK_INTERP[g.kind] || 'PERCENTILE';
  b.setGradientMinpointWithValue(g.minColor || '#ea4335', SpreadsheetApp.InterpolationType[interp], String(g.minValue != null ? g.minValue : 2));
  if (g.midColor != null) {
    b.setGradientMidpointWithValue(g.midColor, SpreadsheetApp.InterpolationType.NUMBER, String(g.midValue != null ? g.midValue : 0));
  }
  b.setGradientMaxpointWithValue(g.maxColor || '#34a853', SpreadsheetApp.InterpolationType[interp], String(g.maxValue != null ? g.maxValue : 98));
  return b.setRanges([range]).build();
}

/** textRules: [{equals, color}] over the whole data range. */
function skTextRules_(sheet, rules, range) {
  return (rules || []).map(function (r) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(r.equals).setBackground(r.color).setRanges([range]).build();
  });
}

/**
 * rowLabelStyles: [{match:{column,prefix,suffix,equals}, style:{bold,background,fontColor,fontSize,merge,rowHeight}}]
 * Applied by scanning a label column — survives section shifts (no hard-coded rows).
 */
function skRowLabelStyles_(sheet, values, width, rules) {
  (rules || []).forEach(function (rule) {
    var col = (rule.match && rule.match.column) || 1;
    for (var i = 0; i < values.length; i++) {
      var label = String(values[i][col - 1] || '');
      if (!matchLabel_(label, rule.match)) continue;
      var r = i + 1;
      var s = rule.style || {};
      var target = s.merge ? sheet.getRange(r, 1, 1, width).merge() : sheet.getRange(r, 1, 1, width);
      if (s.bold) target.setFontWeight('bold');
      if (s.background) target.setBackground(s.background);
      if (s.fontColor) target.setFontColor(s.fontColor);
      if (s.fontSize) target.setFontSize(s.fontSize);
      if (s.rowHeight) sheet.setRowHeight(r, s.rowHeight);
    }
  });
}

function matchLabel_(label, match) {
  if (!match) return false;
  if (match.equals != null) return label === match.equals;
  if (match.prefix != null && label.indexOf(match.prefix) !== 0) return false;
  if (match.suffix != null && label.lastIndexOf(match.suffix) !== label.length - match.suffix.length) return false;
  return match.prefix != null || match.suffix != null;
}

/** Remove existing charts, tolerating transient Google errors. */
function skRemoveCharts_(sheet) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var charts = sheet.getCharts();
      if (!charts.length) return;
      charts.forEach(function (c) { try { sheet.removeChart(c); } catch (ignore) {} });
    } catch (ignore) { SpreadsheetApp.flush(); }
  }
}

/**
 * charts: [{type:'line', title, xColumn, seriesColumns:[..], numHeaders, headerRow,
 *           rowCount, vAxisFormat, colors:[], width, height, position:{row,col}}]
 * Columns are 1-based. Ranges are (headerRow .. headerRow+rowCount).
 */
function skCharts_(sheet, charts) {
  (charts || []).forEach(function (c) {
    var builder = sheet.newChart().asLineChart()
      .addRange(sheet.getRange(c.headerRow, c.xColumn, c.rowCount + 1, 1));
    c.seriesColumns.forEach(function (col) {
      builder.addRange(sheet.getRange(c.headerRow, col, c.rowCount + 1, 1));
    });
    builder.setNumHeaders(c.numHeaders != null ? c.numHeaders : 1);
    if (c.title) builder.setTitle(c.title);
    if (c.vAxisFormat) builder.setOption('vAxis.format', c.vAxisFormat);
    if (c.colors) builder.setOption('colors', c.colors);
    builder.setOption('width', c.width || 920).setOption('height', c.height || 400);
    var pos = c.position || { row: 4, col: 0 };
    builder.setPosition(pos.row, pos.col, 0, 0);
    sheet.insertChart(builder.build());
  });
}

// --- generic renderer -------------------------------------------------------

/**
 * renderTab applies a manifest tab spec to `values`. Pure dispatch: it reads
 * spec fields and calls primitives. No metric names, no domain branches.
 *
 * Resolution note: the manifest addresses columns by NAME; renderTab resolves
 * names to 1-based indices here (kills the A1 off-by-one bug class). `data`
 * never emits A1 letters.
 */
function renderTab(spreadsheet, spec, values) {
  var sheet = spreadsheet.getSheetByName(spec.name) || spreadsheet.insertSheet(spec.name);
  skRemoveCharts_(sheet);

  var written = skWriteTable_(sheet, values);
  var width = written.width;
  var columns = spec.columns || [];

  // Header rows are bold + centered by default (universal sheet convention).
  var headerRowCount = spec.header_row || 1;
  if (written.rows > 0) {
    sheet.getRange(1, 1, headerRowCount, width).setFontWeight('bold').setHorizontalAlignment('center');
  }

  // header merges span the GROUP-header row (row 1) — the top of a 2-row header
  // holds the group labels (RPV/AOV/…); the column-name row sits below it.
  if (spec.header_merges) {
    var merges = spec.header_merges.map(function (m) {
      return { from: columnIndex_(columns, m.from), to: columnIndex_(columns, m.to), label: m.label };
    }).filter(function (m) { return m.from > 0 && m.to > 0; });
    skMergeHeader_(sheet, 1, merges);
  }

  // firstRow/rowCount for value styling: rows after the header block.
  var headerRows = spec.header_row || 1;
  var firstDataRow = headerRows + 1;
  var dataRowCount = Math.max(0, written.rows - headerRows);

  if (spec.number_formats) {
    skNumberFormats_(sheet, spec.number_formats.map(function (nf) {
      return { column: columnIndex_(columns, nf.column), format: nf.format, firstRow: firstDataRow, rowCount: dataRowCount };
    }).filter(function (nf) { return nf.column > 0; }));
  }

  if (spec.gradients) {
    var rules = spec.gradients.map(function (g) {
      return skGradientRule_(sheet, {
        column: columnIndex_(columns, g.column), firstRow: firstDataRow, rowCount: dataRowCount, kind: g.kind,
        minColor: g.min_color, midColor: g.mid_color, maxColor: g.max_color,
        minValue: g.min_value, midValue: g.mid_value, maxValue: g.max_value
      });
    });
    if (spec.text_rules) {
      rules = rules.concat(skTextRules_(sheet, spec.text_rules, sheet.getRange(1, 1, written.rows, width)));
    }
    sheet.setConditionalFormatRules(rules);
  } else if (spec.text_rules) {
    sheet.setConditionalFormatRules(skTextRules_(sheet, spec.text_rules, sheet.getRange(1, 1, written.rows, width)));
  }

  if (spec.row_label_styles) skRowLabelStyles_(sheet, normalizeWidth_(values), width, spec.row_label_styles);

  skFreeze_(sheet, spec.freeze);

  if (spec.column_widths) {
    skColumnWidths_(sheet, spec.column_widths.map(function (cw) {
      return { column: columnIndex_(columns, cw.column), width: cw.width };
    }).filter(function (cw) { return cw.column > 0; }));
  }

  if (spec.charts) {
    skCharts_(sheet, spec.charts.map(function (c) {
      return {
        type: c.type, title: c.title, numHeaders: c.num_headers, headerRow: headerRows,
        rowCount: dataRowCount, vAxisFormat: c.v_axis_format, colors: c.colors,
        width: c.width, height: c.height, position: c.position,
        xColumn: columnIndex_(columns, c.x),
        seriesColumns: c.series.map(function (s) { return columnIndex_(columns, s); })
      };
    }));
  }

  SpreadsheetApp.flush();
  return { sheet: spec.name, rows: written.rows };
}

// CommonMS/Node test hook (Apps Script ignores module).
if (typeof module !== 'undefined') {
  module.exports = { columnName_: columnName_, columnIndex_: columnIndex_, normalizeWidth_: normalizeWidth_, matchLabel_: matchLabel_, resolveFormula_: resolveFormula_ };
}
