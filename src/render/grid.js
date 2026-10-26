/**
 * grid — pure layout logic: A1 helpers, name-based
 * formula resolution, the long→grid value builder, manual-column preservation,
 * label matching, gradient runs/points, compareStyle formulas and chart layout.
 *
 * No I/O. The renderer and primitives import these helpers directly.
 */

/** A1 column letter from a 1-based column index. columnName_(50) === 'AX'. */
export function columnName_(index) {
  var name = '';
  while (index > 0) {
    var rem = (index - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

/** Pad ragged rows to a common width before writing. */
export function normalizeWidth_(values) {
  var width = 1;
  for (var i = 0; i < values.length; i++) width = Math.max(width, values[i].length);
  return values.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
}

/** 1-based column index for a manifest column name, or 0 if absent. */
export function columnIndex_(columns, name) {
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
export function resolveFormula_(formula, columns, sheetRow) {
  return formula.replace(/\{([^}]+)\}/g, function (_, name) {
    var idx = columnIndex_(columns, name);
    if (idx === 0) return '#REF!';
    return columnName_(idx) + sheetRow;
  });
}

function headerLabels_(columns) {
  return columns.map(function (c) { return c.header != null ? c.header : c.name; });
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
export function buildGrid_(spec, rows) {
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
    grid.push(headerLabels_(columns));
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
      grid.push(headerLabels_(columns));
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

export function rowKeyValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    var month = String(value.getMonth() + 1).padStart(2, '0');
    var day = String(value.getDate()).padStart(2, '0');
    return value.getFullYear() + '-' + month + '-' + day;
  }
  return String(value == null ? '' : value);
}

/**
 * Preserve user-entered columns by a stable row key before replacing a table.
 * oldValues is the sheet as it stands (header rows + data rows); a preserved
 * column keeps its old cell for every new row whose row_key matches an old row.
 */
export function preserveValues_(spec, oldValues, newValues) {
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
    oldColumns.forEach(function (column, i) { copy[column.index] = old[i] == null ? '' : old[i]; });
    return copy;
  });
}

export function matchLabel_(label, match) {
  if (!match) return false;
  if (match.empty) return label === '';
  if (match.equals != null) return label === match.equals;
  if (match.prefix != null && label.indexOf(match.prefix) !== 0) return false;
  if (match.suffix != null && label.lastIndexOf(match.suffix) !== label.length - match.suffix.length) return false;
  return match.prefix != null || match.suffix != null;
}

/** Partition a gradient into contiguous row runs when it has a group_by column. */
export function gradientRuns_(values, columns, firstDataRow, dataRowCount, groupBy) {
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

/**
 * gradientPoints_ resolves a manifest gradient into its three interpolation
 * points: { color, type, value? } with type NUMBER | PERCENT | PERCENTILE | MIN |
 * MAX. A MIN/MAX endpoint (kind "min"/"max") carries no value: it anchors to the
 * range's actual extremes. mid is null when the gradient has no mid_color.
 */
export function gradientPoints_(g) {
  var INTERP = { number: 'NUMBER', percent: 'PERCENT', percentile: 'PERCENTILE', min: 'MIN', max: 'MAX' };
  var minKind = g.min_kind || g.kind;
  var maxKind = g.max_kind || g.kind;
  var minColor = g.min_color || '#ea4335';
  var maxColor = g.max_color || '#34a853';
  return {
    min: minKind === 'min'
      ? { color: minColor, type: 'MIN' }
      : { color: minColor, type: INTERP[minKind] || 'PERCENTILE', value: String(g.min_value != null ? g.min_value : 2) },
    mid: g.mid_color != null
      ? { color: g.mid_color, type: INTERP[g.mid_kind || 'number'] || 'NUMBER', value: String(g.mid_value != null ? g.mid_value : 0) }
      : null,
    max: maxKind === 'max'
      ? { color: maxColor, type: 'MAX' }
      : { color: maxColor, type: INTERP[maxKind] || 'PERCENTILE', value: String(g.max_value != null ? g.max_value : 98) },
  };
}

/**
 * compareFormula_ is the custom-formula condition that styles column `self` on
 * `row` when it holds the larger number of the pair. Cells may be formatted
 * strings ("$3.46", "3.55%"): everything but digits/./- is stripped before
 * comparing, and blanks never win (VALUE("") is 0 in Sheets).
 */
export function compareFormula_(self, other, row) {
  var num = function (col) {
    return 'IFERROR(VALUE(REGEXREPLACE($' + columnName_(col) + row + ',"[^0-9.\\-]","")),"")';
  };
  var s = num(self), o = num(other);
  var a = '$' + columnName_(self) + row, b = '$' + columnName_(other) + row;
  return '=AND(' + a + '<>"",' + b + '<>"",ISNUMBER(' + s + '),ISNUMBER(' + o + '),' + s + '>' + o + ')';
}

/**
 * chartLayout_ resolves a manifest chart against the rendered tab: the header
 * row its data starts at, the data height (header included), the x + series
 * columns, and the 1-based anchor row/col. Returns null when the chart can't be
 * placed (unknown x, fewer than 2 rows, missing __header__ or anchor section),
 * in which case the renderer skips it.
 */
export function chartLayout_(ctx, c) {
  var headerRow = ctx.headerRows;
  if (c.data_from_last_header) {
    if (!(ctx.headers || []).length) return null;
    headerRow = ctx.headers[ctx.headers.length - 1].row;
  }
  var height = ctx.rows - headerRow + 1;
  var xColumn = columnIndex_(ctx.columns, c.x);
  if (xColumn <= 0 || height < 2) return null;

  var cols = [xColumn];
  (c.series || []).forEach(function (name) {
    var col = columnIndex_(ctx.columns, name);
    if (col > 0) cols.push(col);
  });

  var pos = c.position || { row: 4, col: 0 };
  var row = pos.row;
  if (c.anchor_section) {
    var anchor = (ctx.sections || []).filter(function (s) { return s.level === c.anchor_section; })[0];
    if (!anchor) return null;
    row = anchor.row;
  }
  return { headerRow: headerRow, height: height, cols: cols, row: row, col: pos.col };
}
