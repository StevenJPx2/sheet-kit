/**
 * webhook — generic Apps Script web app for sheet-kit.
 *
 * Domain-agnostic transport. Authenticates a token, resolves the manifest
 * (embedded by `sheet-kit compile`, else read from Drive), reads the data
 * artifact, and renders every tab through renderTab (runtime/core.js). No
 * per-report functions — a new sheet needs no webhook change.
 *
 * POST { token, manifest?, data?, expectedLatest?, action? }
 *   token          — sha256 must match Script Property SHEETKIT_SECRET_HASH
 *   action=inspect — return spreadsheet structure (+ cells) instead of rendering
 *   expectedLatest — staleness handshake: reject if the data is older
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
      rendered.push(renderTab(ss, spec, rowsToValues_(spec, rows)));
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
 * Runs inside Apps Script's existing Sheets authorization — the CLI needs no
 * browser cookies or separate OAuth credential.
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
