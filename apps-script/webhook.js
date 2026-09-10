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

    var manifest = readJsonByName_(String(payload.manifest || 'manifest.json'));
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
      var rows = data.datasets[spec.data_key] || [];
      var values = rowsToValues_(spec, rows);
      rendered.push(renderTab(ss, spec, values));
    });

    return jsonResponse_({ ok: true, tabs: rendered });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String((error && error.message) || error) });
  }
}

/**
 * rowsToValues_ turns canonical row objects into the 2D display grid renderTab
 * expects: a header row of column names, then one row per record pulling
 * source_field values. Formula columns are left blank here (the render layer
 * writes their A1 formulas separately once wired); today they resolve to '').
 *
 * ponytail: formula columns render as blank cells until formula emission lands.
 * The header + source_field mapping is what every sheet needs now.
 */
function rowsToValues_(spec, rows) {
  var columns = spec.columns || [];
  var header = columns.map(function (c) { return c.name; });
  var grid = [header];
  rows.forEach(function (row) {
    grid.push(columns.map(function (c) {
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
