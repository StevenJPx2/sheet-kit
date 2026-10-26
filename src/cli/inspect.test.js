import assert from "node:assert/strict";
import { test } from "node:test";

import { a1, columnLetters, fieldMask, inspectViaSheetsApi, mapSpreadsheet, parseA1 } from "./inspect.js";

// A spreadsheets.get response as the field mask returns it: a 2-row table on
// "Daily" (header bold + blue, a formula, a percent format) and an empty "Notes".
const RESPONSE = {
  spreadsheetId: "SS1",
  properties: { title: "Acme Dashboard", locale: "en_US", timeZone: "America/Toronto" },
  sheets: [
    {
      properties: { sheetId: 11, title: "Daily", gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1, frozenColumnCount: 1 } },
      merges: [
        { sheetId: 11, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 3 },
        { sheetId: 11, startRowIndex: 50, endRowIndex: 52, startColumnIndex: 0, endColumnIndex: 2 },
      ],
      conditionalFormats: [
        { ranges: [{ sheetId: 11, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 }], gradientRule: { minpoint: {} } },
        { ranges: [{ sheetId: 11, startColumnIndex: 0, endColumnIndex: 1 }], booleanRule: {} },
      ],
      data: [{
        rowData: [
          { values: [
            { userEnteredValue: { stringValue: "Date" }, formattedValue: "Date", userEnteredFormat: { textFormat: { bold: true }, backgroundColorStyle: { rgbColor: { red: 0.85, green: 0.9176, blue: 0.9686 } }, horizontalAlignment: "CENTER", wrapStrategy: "WRAP" } },
            { userEnteredValue: { stringValue: "Sessions" }, formattedValue: "Sessions", userEnteredFormat: { textFormat: { bold: true } } },
            { userEnteredValue: { stringValue: "CVR" }, formattedValue: "CVR" },
          ] },
          { values: [
            { userEnteredValue: { stringValue: "2026-10-25" }, formattedValue: "2026-10-25", userEnteredFormat: { wrapStrategy: "CLIP" } },
            { userEnteredValue: { numberValue: 120 }, formattedValue: "120" },
            { userEnteredValue: { formulaValue: "=IFERROR(B2/100,\"\")" }, formattedValue: "120.00%", userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.00%" }, backgroundColor: { red: 1 } } },
          ] },
          { values: [{ userEnteredFormat: { textFormat: { bold: true } } }] },
        ],
      }],
    },
    { properties: { sheetId: 12, title: "Notes", hidden: true, gridProperties: { rowCount: 1000, columnCount: 26 } }, data: [{}] },
  ],
};

test("structure maps to the public inspect shape", () => {
  assert.deepEqual(mapSpreadsheet(RESPONSE, {}), {
    id: "SS1",
    name: "Acme Dashboard",
    locale: "en_US",
    timezone: "America/Toronto",
    sheets: [
      {
        name: "Daily",
        id: 11,
        hidden: false,
        rows: 2,
        columns: 3,
        frozen_rows: 1,
        frozen_columns: 1,
        merges: ["B1:C1"],
        conditional_formats: [{ ranges: ["C2:C3"], type: "gradient" }, { ranges: ["A:A"], type: "boolean" }],
      },
      { name: "Notes", id: 12, hidden: true, rows: 0, columns: 0, frozen_rows: 0, frozen_columns: 0, merges: [], conditional_formats: [] },
    ],
  });
});

test("--cells adds values, formulas, formats and explicit defaults", () => {
  const [daily] = mapSpreadsheet(RESPONSE, { sheet: "Daily", cells: true }).sheets;
  assert.equal(daily.range, "A1:C2");
  assert.deepEqual(daily.values, [["Date", "Sessions", "CVR"], ["2026-10-25", "120", "120.00%"]]);
  assert.deepEqual(daily.formulas, [["", "", ""], ["", "", "=IFERROR(B2/100,\"\")"]]);
  assert.deepEqual(daily.number_formats, [["0.###############", "0.###############", "0.###############"], ["0.###############", "0.###############", "0.00%"]]);
  assert.deepEqual(daily.backgrounds, [["#d9eaf7", "#ffffff", "#ffffff"], ["#ffffff", "#ffffff", "#ff0000"]]);
  assert.deepEqual(daily.font_weights, [["bold", "bold", "normal"], ["normal", "normal", "normal"]]);
  assert.deepEqual(daily.horizontal_alignments, [["center", "general", "general"], ["general", "general", "general"]]);
  assert.deepEqual(daily.wrap_strategies, [["WRAP", "OVERFLOW", "OVERFLOW"], ["CLIP", "OVERFLOW", "OVERFLOW"]]);
});

test("--range slices (and pads past the data) like sheet.getRange", () => {
  const [daily] = mapSpreadsheet(RESPONSE, { sheet: "Daily", range: "A1:A4", cells: true }).sheets;
  assert.equal(daily.range, "A1:A4");
  assert.deepEqual(daily.values, [["Date"], ["2026-10-25"], [""], [""]]);
  assert.deepEqual(daily.font_weights, [["bold"], ["normal"], ["bold"], ["normal"]]);

  const [single] = mapSpreadsheet(RESPONSE, { sheet: "Daily", range: "C2", cells: true }).sheets;
  assert.equal(single.range, "C2");
  assert.deepEqual(single.formulas, [["=IFERROR(B2/100,\"\")"]]);
});

test("an empty sheet's data range is A1", () => {
  const [notes] = mapSpreadsheet(RESPONSE, { sheet: "Notes", cells: true }).sheets;
  assert.equal(notes.range, "A1");
  assert.deepEqual(notes.values, [[""]]);
});

test("an unknown --sheet is an error", () => {
  assert.throws(() => mapSpreadsheet(RESPONSE, { sheet: "Nope" }), /sheet not found: Nope/);
});

test("A1 helpers", () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(columnLetters), ["A", "Z", "AA", "ZZ", "AAA"]);
  assert.deepEqual(parseA1("'Daily'!$B$2:D9", 100, 26), { r0: 1, r1: 9, c0: 1, c1: 4, form: undefined });
  assert.equal(a1(parseA1("A:C", 1000, 26)), "A:C");
  assert.equal(a1(parseA1("2:5", 1000, 26)), "2:5");
  assert.throws(() => parseA1("nonsense!", 10, 10), /invalid A1 range/);
  for (const invalid of ["A0", "B2:A1", "A11", "A1:Z1", "A1:B", "1:B2"]) {
    assert.throws(() => parseA1(invalid, 10, 10), /invalid A1 range/);
  }
});

test("inspectViaSheetsApi sends one spreadsheets.get with the field mask and sheet range", async () => {
  let call;
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    call = { url: new URL(String(url)), init };
    return Response.json(RESPONSE);
  };
  const out = await inspectViaSheetsApi("tok", { spreadsheetId: "SS1", sheet: "Daily", cells: true }, fetchImpl);
  assert.equal(call.url.origin + call.url.pathname, "https://sheets.googleapis.com/v4/spreadsheets/SS1");
  assert.equal(call.url.searchParams.get("fields"), fieldMask(true));
  assert.deepEqual(call.url.searchParams.getAll("ranges"), ["'Daily'"]);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.Authorization, "Bearer tok");
  assert.equal(out.sheets.length, 1);
});

test("inspectViaSheetsApi turns the API's bad-range error for --sheet into sheet not found", async () => {
  /** @type {typeof fetch} */
  const fetchImpl = async () => Response.json({ error: { code: 400, message: "Unable to parse range: 'Nope'", status: "INVALID_ARGUMENT" } }, { status: 400 });
  await assert.rejects(inspectViaSheetsApi("tok", { spreadsheetId: "SS1", sheet: "Nope" }, fetchImpl), /sheet not found: Nope/);
});
