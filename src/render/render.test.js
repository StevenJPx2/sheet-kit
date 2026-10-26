// The Sheets API renderer, offline: golden request fixtures, end-to-end runs
// against an in-memory Sheets API, and parity with the Apps Script renderer
// (the real compiled bundle run against an in-memory SpreadsheetApp).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chunkBySize } from "../google/sheets.js";
import { PRIMITIVES } from "../primitives/index.js";
import { validate } from "../utils/validate.js";
import { planRender, renderManifest, sheetStates } from "./render.js";
import { fakeAppsScript } from "./testing/fake-apps-script.js";
import { fakeSheetsApi } from "./testing/fake-sheets-api.js";
import { data, manifest } from "./testing/fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const noWait = { wait: async () => {} };

/** Compare with (or, with UPDATE_GOLDEN=1, rewrite) a JSON fixture. */
function golden(name, actual) {
  const path = join(here, "testing", "golden", `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(path, "utf8")));
}

test("the fixture manifest is valid and covers every primitive", () => {
  const m = manifest();
  assert.equal(validate(m), "");
  for (const p of PRIMITIVES) {
    if (p.field) assert.ok(m.tabs.some((t) => t[p.field] != null), `fixture should use ${p.name}`);
  }
});

test("planRender: golden requests for a re-render over an existing styled tab", () => {
  // "Daily" exists with 2 conditional-format rules, a chart, a frozen column
  // and the Apps Script renderer's incremental state; "Stacked" is new.
  const states = sheetStates({
    sheets: [
      { properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } },
      {
        properties: { sheetId: 7, title: "Daily", index: 1, gridProperties: { rowCount: 5, columnCount: 5, frozenRowCount: 2, frozenColumnCount: 1 } },
        conditionalFormats: [{ ranges: [{ sheetId: 7 }] }, { ranges: [{ sheetId: 7 }] }],
        charts: [{ chartId: 99 }],
        developerMetadata: [{ metadataId: 5, metadataKey: "sk_layout" }, { metadataId: 6, metadataKey: "other" }],
      },
    ],
  });
  const plan = planRender(manifest(), data(), states);
  golden("plan", plan);

  assert.ok(plan.reset.some((r) => r.deleteEmbeddedObject) === false, "charts are replaced by the chart primitive, in the style batch");
  assert.deepEqual(plan.style.filter((r) => r.deleteEmbeddedObject), [{ deleteEmbeddedObject: { objectId: 99 } }]);
  assert.deepEqual(plan.reset.filter((r) => r.deleteConditionalFormatRule).map((r) => r.deleteConditionalFormatRule.index), [1, 0]);
  assert.deepEqual(plan.reset.filter((r) => r.deleteDeveloperMetadata), [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: 5 } } } }]);
  assert.ok(plan.reset.some((r) => r.updateSheetProperties?.properties.gridProperties?.rowCount === 1000 || r.updateSheetProperties?.fields === "gridProperties.rowCount,gridProperties.columnCount"), "grid grows to fit");
});

test("formulas are resolved per row; banner and formula headings resolve against their data row", () => {
  const plan = planRender(manifest(), data(), new Map());
  const daily = plan.values.find((v) => v.range === "'Daily'!A1").values;
  assert.equal(daily[0][0], '=IF(F4>0.02,"Above target","Below target")', "banner reads the first data row");
  assert.equal(daily[1][2], "Traffic", "group label on the row above the column names");
  assert.equal(daily[4][4], '=IFERROR(D5/C5,"")');
  const stacked = plan.values.find((v) => v.range === "'Stacked'!A1").values;
  assert.equal(stacked[1][0], '=IF(B4>1,"up","down")', "a formula heading reads its block's next data row");
});

test("renderManifest: one get + two batchUpdates + one values write, and the sheet matches the plan", async () => {
  const api = fakeSheetsApi();
  const result = await renderManifest(manifest(), data(), { token: "t", deps: { fetchImpl: api.fetchImpl, ...noWait } });
  assert.equal(result.calls, 4);
  assert.deepEqual(result.tabs.map((t) => [t.sheet, t.rows]), [["Daily", 8], ["Stacked", 9], ["Log", 3]]);
  assert.deepEqual(api.snapshot().order, ["Daily", "Sheet1", "Stacked", "Log"]);
  assert.equal(api.snapshot().sheets.Stacked.hidden, true);
  for (const call of api.book.log) assert.ok(JSON.stringify(call.body ?? {}).length < 1_500_000);
  golden("sheet", api.snapshot());
});

test("a re-render changes data only: no duplicate charts or conditional formats", async () => {
  const api = fakeSheetsApi();
  const deps = { fetchImpl: api.fetchImpl, ...noWait };
  // The first render of a new spreadsheet places tabs in creation order; from
  // the second on, placement has settled and a re-render is a no-op.
  await renderManifest(manifest(), data(), { token: "t", deps });
  await renderManifest(manifest(), data(), { token: "t", deps });
  const first = api.snapshot();
  await renderManifest(manifest(), data(), { token: "t", deps });
  const second = api.snapshot();
  assert.deepEqual(second, first);
  assert.deepEqual(second.order, ["Daily", "Sheet1", "Log", "Stacked"]);
  assert.equal(second.sheets.Daily.charts.length, 1);
  assert.equal(second.sheets.Stacked.charts.length, 1);
  assert.equal(second.sheets.Daily.cf.length, 3 + 1 + 2);

  await renderManifest(manifest(), data({ revenue: 50 }), { token: "t", deps });
  const third = api.snapshot();
  assert.equal(third.sheets.Daily.cells["4,3"].v, 50);
  assert.equal(third.sheets.Daily.charts.length, 1);
  assert.equal(third.sheets.Daily.cf.length, 6);
});

test("preserved columns keep user-entered values by row key, in both renderers", async () => {
  const api = fakeSheetsApi();
  const legacy = fakeAppsScript(["Sheet1"]);
  const deps = { fetchImpl: api.fetchImpl, ...noWait };
  await renderManifest(manifest(), data(), { token: "t", deps });
  legacy.render(manifest(), data());

  // A user types a note next to 2026-09-13 (sheet row 3, column C).
  api.book.sheets.find((s) => s.title === "Log").cells.set("2,2", { value: "promo day", format: {} });
  legacy.book.sheets.find((s) => s.name === "Log").cells.set("2,2", { value: "promo day", format: {} });

  // Next publish: a new day arrives on top, so 2026-09-13 moves down a row.
  const next = data();
  next.datasets.log.unshift({ date: "2026-09-15", orders: 4 });
  const result = await renderManifest(manifest(), next, { token: "t", deps });
  legacy.render(manifest(), next);
  assert.equal(result.calls, 5, "one values.batchGet for the preserve tab");

  const cells = api.snapshot().sheets.Log.cells;
  assert.equal(cells["3,0"].v, "2026-09-13");
  assert.equal(cells["3,2"].v, "promo day");
  assert.equal(cells["2,2"]?.v, undefined);
  assert.deepEqual(cells, legacy.snapshot().sheets.Log.cells);
});

/** @param {any} a @param {any} b @param {string} when */
function assertSameSheets(a, b, when) {
  assert.deepEqual(b.order, a.order, `${when}: tab order`);
  for (const name of a.order) {
    for (const key of Object.keys(a.sheets[name])) {
      assert.deepEqual(b.sheets[name][key], a.sheets[name][key], `${when}: ${name}.${key}`);
    }
  }
}

test("parity: the API renderer produces what the Apps Script renderer produces", async () => {
  const legacy = fakeAppsScript(["Sheet1"]);
  const api = fakeSheetsApi();
  const deps = { fetchImpl: api.fetchImpl, ...noWait };

  legacy.render(manifest(), data());
  await renderManifest(manifest(), data(), { token: "t", deps });
  assertSameSheets(legacy.snapshot(), api.snapshot(), "first render");

  // Re-render with different data and fewer rows over the styled sheet.
  const next = data({ revenue: 40 });
  next.datasets.daily.splice(2, 1);
  legacy.render(manifest(), next);
  await renderManifest(manifest(), next, { token: "t", deps });
  assertSameSheets(legacy.snapshot(), api.snapshot(), "re-render");
});

test("warnings name what the API can't reproduce", () => {
  const m = manifest();
  m.tabs[0].charts[0].v_axis_format = "0%";
  m.tabs[0].charts[0].options = { "legend.position": "bottom", "hAxis.slantedText": true };
  m.tabs[0].compare_style[0].style.underline = true;
  const { warnings } = planRender(m, data(), new Map());
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((w) => w.startsWith("Daily: ")));
  assert.match(warnings.join("\n"), /v_axis_format/);
  assert.match(warnings.join("\n"), /hAxis\.slantedText/);
  assert.match(warnings.join("\n"), /underline/);
});

test("an API error stops the render with the API's message", async () => {
  const api = fakeSheetsApi();
  const m = manifest();
  m.spreadsheet_id = "OTHER";
  await assert.rejects(renderManifest(m, data(), { token: "t", deps: { fetchImpl: api.fetchImpl, ...noWait } }), /HTTP 404.*spreadsheet id/);
});

test("chunkBySize keeps each write under the byte budget, in order", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(90) }));
  const chunks = chunkBySize(items, 300);
  assert.deepEqual(chunks.flat(), items);
  for (const c of chunks) assert.ok(JSON.stringify(c).length <= 300 + c.length);
  assert.equal(chunkBySize([{ big: "y".repeat(500) }], 300).length, 1, "an oversized item travels alone");
});
