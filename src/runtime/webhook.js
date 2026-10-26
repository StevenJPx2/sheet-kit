/**
 * webhook — generic Apps Script web app for sheet-kit.
 *
 * Domain-agnostic transport. Authenticates a token, uses the manifest embedded
 * by `sheet-kit compile`, parses the data sent inline, and renders every tab
 * through renderTab (runtime/core.js). No per-report functions — a new sheet
 * needs no webhook change.
 *
 * POST { token, dataInline?, force?, profile?, action? }
 *   token          — sha256 must match Script Property SHEETKIT_SECRET_HASH
 *   dataInline     — the data.json bytes to render (required unless inspecting)
 *   action=inspect — return spreadsheet structure (+ cells) instead of rendering
 *   force          — skip the incremental (values-only) path; full re-render
 *   profile        — return per-primitive render timings (adds flush latency)
 */

function doPost(event) {
  try {
    var payload = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    var expectedHash = PropertiesService.getScriptProperties().getProperty('SHEETKIT_SECRET_HASH') || '';
    if (!secureEqual_(sha256_(String(payload.token || '')), expectedHash)) {
      return jsonResponse_({ ok: false, error: 'unauthorized' });
    }

    var manifest = compiledManifest_();
    if (!manifest) throw new Error('compiled manifest missing');

    if (payload.action === 'inspect') {
      var inspectId = String(payload.spreadsheetId || manifest.spreadsheet_id);
      return jsonResponse_({ ok: true, spreadsheet: inspectSpreadsheet_(inspectId, payload) });
    }

    // The data travels inline: we render exactly the bytes we were sent.
    if (payload.dataInline == null) {
      return jsonResponse_({ ok: false, error: 'dataInline missing (Drive-staged data is no longer read; upgrade sheet-kit)' });
    }
    var data = JSON.parse(String(payload.dataInline));

    if (manifest.contract_version !== 1 || data.contract_version !== 1) {
      return jsonResponse_({ ok: false, error: 'unsupported contract_version' });
    }

    var ss = SpreadsheetApp.openById(manifest.spreadsheet_id);
    var renderOptions = { force: Boolean(payload.force), profile: Boolean(payload.profile) };
    var rendered = [];
    manifest.tabs.forEach(function (spec) {
      if (!Object.prototype.hasOwnProperty.call(data.datasets || {}, spec.data_key)) return;
      var rows = data.datasets[spec.data_key] || [];
      rendered.push(renderTab(ss, spec, rows, renderOptions));
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
      hidden: sheet.isSheetHidden(),
      rows: sheet.getLastRow(),
      columns: sheet.getLastColumn(),
      frozen_rows: sheet.getFrozenRows(),
      frozen_columns: sheet.getFrozenColumns(),
      merges: sheet.getDataRange().getMergedRanges().map(function (range) { return range.getA1Notation(); }),
      conditional_formats: sheet.getConditionalFormatRules().map(function (rule) {
        var ranges = rule.getRanges().map(function (r) { return r.getA1Notation(); });
        var gradient = rule.getGradientCondition();
        return { ranges: ranges, type: gradient ? 'gradient' : 'boolean' };
      })
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
    result.wrap_strategies = range.getWrapStrategies().map(function (row) {
      return row.map(function (strategy) { return String(strategy); });
    });
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
