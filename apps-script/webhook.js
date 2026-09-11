/**
 * webhook — generic Apps Script web app for sheet-kit.
 *
 * Domain-agnostic. It authenticates a token, reads the manifest + data artifact
 * from Drive (written by `data`), and renders every tab through renderTab. There
 * are NO per-report functions — a new sheet needs no webhook change.
 *
 * POST body: { token, manifest: "<drive filename>", data: "<drive filename>", expectedLatest? }
 *   token          — sha256 must match SHEETKIT_SECRET_HASH (set as a Script Property)
 *   manifest/data  — filenames in the mounted Drive folder to read
 *   expectedLatest — optional staleness handshake: reject if data is older
 */

function doPost(event) {
  try {
    var payload = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    var expectedHash = PropertiesService.getScriptProperties().getProperty('SHEETKIT_SECRET_HASH') || '';
    if (!secureEqual_(sha256_(String(payload.token || '')), expectedHash)) {
      return jsonResponse_({ ok: false, error: 'unauthorized' });
    }

    var manifest = compiledManifest_() || readJsonByName_(String(payload.manifest || 'manifest.json'));

    if (payload.action === 'inspect') {
      return jsonResponse_({ ok: true, spreadsheet: inspectSpreadsheet_(manifest.spreadsheet_id, payload) });
    }

    var data = readJsonByName_(String(payload.data || 'data.json'));

    if (manifest.contract_version !== 1 || data.contract_version !== 1) {
      return jsonResponse_({ ok: false, error: 'unsupported contract_version' });
    }

    var expectedLatest = String(payload.expectedLatest || '');
    if (expectedLatest && dataLatestDate_(data) < expectedLatest) {
      return jsonResponse_({ ok: false, stale: true, latest: dataLatestDate_(data) });
    }

    var ss = SpreadsheetApp.openById(manifest.spreadsheet_id);
    var rendered = [];
    manifest.tabs.forEach(function (spec) {
      if (!Object.prototype.hasOwnProperty.call(data.datasets || {}, spec.data_key)) return;

      var rows = data.datasets[spec.data_key] || [];
      var values = rowsToValues_(spec, rows);
      rendered.push(renderTab(ss, spec, values));
    });

    return jsonResponse_({ ok: true, tabs: rendered });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String((error && error.message) || error) });
  }
}

/** Return the manifest embedded by `sheet-kit compile`, when present. */
function compiledManifest_() {
  return typeof SHEETKIT_MANIFEST === 'undefined' ? null : SHEETKIT_MANIFEST;
}

/**
 * Inspect spreadsheet structure, with optional cell-level detail for one sheet.
 * This runs inside Apps Script's existing Sheets authorization, so the CLI does
 * not need browser cookies or a separate OAuth credential.
 */
function inspectSpreadsheet_(spreadsheetId, payload) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var requestedSheet = String(payload.sheet || '');
  var requestedRange = String(payload.range || '');
  var includeCells = Boolean(payload.cells);

  var sheets = ss.getSheets().filter(function (sheet) {
    return !requestedSheet || sheet.getName() === requestedSheet;
  }).map(function (sheet) {
    var result = {
      name: sheet.getName(),
      id: sheet.getSheetId(),
      rows: sheet.getLastRow(),
      columns: sheet.getLastColumn(),
      frozen_rows: sheet.getFrozenRows(),
      frozen_columns: sheet.getFrozenColumns(),
      merges: sheet.getDataRange().getMergedRanges().map(function (range) { return range.getA1Notation(); })
    };

    if (!includeCells) return result;

    var range = requestedRange ? sheet.getRange(requestedRange) : sheet.getDataRange();
    result.range = range.getA1Notation();
    result.values = range.getDisplayValues();
    result.formulas = range.getFormulas();
    result.number_formats = range.getNumberFormats();
    result.backgrounds = range.getBackgrounds();
    result.font_weights = range.getFontWeights();
    result.horizontal_alignments = range.getHorizontalAlignments();
    return result;
  });

  if (requestedSheet && sheets.length === 0) throw new Error('sheet not found: ' + requestedSheet);

  return {
    id: ss.getId(),
    name: ss.getName(),
    locale: ss.getSpreadsheetLocale(),
    timezone: ss.getSpreadsheetTimeZone(),
    sheets: sheets
  };
}

/**
 * rowsToValues_ turns canonical row objects into the 2D display grid renderTab
 * expects:
 *   - an optional group-header row (when header_row >= 2) built from
 *     header_merges labels,
 *   - the column-name header row,
 *   - one row per record: source_field columns pull the value; formula columns
 *     emit a Sheets formula with {ColName} resolved to that row's A1 cells.
 */
function rowsToValues_(spec, rows) {
  var columns = spec.columns || [];
  var headerRows = spec.header_row || 1;
  var grid = [];

  // Group-header row (row 0) from header_merges labels, when a 2-row header.
  if (headerRows >= 2 && spec.header_merges) {
    var groupRow = columns.map(function () { return ''; });
    spec.header_merges.forEach(function (m) {
      var from = columnIndex_(columns, m.from);
      if (from > 0) groupRow[from - 1] = m.label;
    });
    grid.push(groupRow);
  }
  // Column-name header row (display header, or the unique name when unset).
  grid.push(columns.map(function (c) { return c.header != null ? c.header : c.name; }));


  // Data rows: source_field value, or a per-row resolved formula.
  rows.forEach(function (row, i) {
    var sheetRow = headerRows + 1 + i;
    grid.push(columns.map(function (c) {
      if (c.formula) return resolveFormula_(c.formula, columns, sheetRow);
      if (c.source_field == null) return '';
      var v = row[c.source_field];
      return v == null ? '' : v;
    }));
  });
  return grid;
}

/** Scan every string cell that looks like a date; return the max. */
function dataLatestDate_(data) {
  var latest = '';
  Object.keys(data.datasets || {}).forEach(function (key) {
    (data.datasets[key] || []).forEach(function (row) {
      Object.keys(row).forEach(function (field) {
        var v = String(row[field] || '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v > latest) latest = v;
      });
    });
  });
  return latest;
}

function readJsonByName_(name) {
  var files = DriveApp.getFilesByName(name);
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) throw new Error('artifact not found by name: ' + name);
  return JSON.parse(newest.getBlob().getDataAsString());
}

function sha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return ((byte + 256) % 256).toString(16).padStart(2, '0'); })
    .join('');
}

function secureEqual_(left, right) {
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== 'undefined') {
  module.exports = { rowsToValues_: rowsToValues_, dataLatestDate_: dataLatestDate_ };
}
