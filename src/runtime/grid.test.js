// grid.js is imported directly by the Node renderer and stripped into the Apps
// Script bundle; these pin the helpers that used to live inside primitive bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { chartLayout_, compareFormula_, gradientPoints_, preserveValues_ } from "./grid.js";
import { appsScriptCore } from "../utils/compiler.js";

test("the bundle exposes grid helpers as globals with identical behaviour", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(appsScriptCore(), sandbox);
  assert.equal(sandbox.compareFormula_(2, 1, 3), compareFormula_(2, 1, 3));
  assert.equal(typeof sandbox.chartLayout_, "function");
});

test("compareFormula_ keeps the original blank-guarded comparison", () => {
  const num = (c) => `IFERROR(VALUE(REGEXREPLACE($${c}3,"[^0-9.\\-]","")),"")`;
  assert.equal(
    compareFormula_(2, 1, 3),
    `=AND($B3<>"",$A3<>"",ISNUMBER(${num("B")}),ISNUMBER(${num("A")}),${num("B")}>${num("A")})`,
  );
});

test("gradientPoints_ applies the defaults and the MIN/MAX no-value endpoints", () => {
  assert.deepEqual(gradientPoints_({ kind: "percentile" }), {
    min: { color: "#ea4335", type: "PERCENTILE", value: "2" },
    mid: null,
    max: { color: "#34a853", type: "PERCENTILE", value: "98" },
  });
  const p = gradientPoints_({ kind: "number", min_kind: "min", max_kind: "max", mid_color: "#fff", mid_kind: "percentile", mid_value: 50 });
  assert.deepEqual(p.min, { color: "#ea4335", type: "MIN" });
  assert.deepEqual(p.mid, { color: "#fff", type: "PERCENTILE", value: "50" });
  assert.deepEqual(p.max, { color: "#34a853", type: "MAX" });
});

test("chartLayout_ follows data_from_last_header and anchor_section, else null", () => {
  const ctx = {
    headerRows: 1, rows: 10,
    columns: [{ name: "Date" }, { name: "RPV" }, { name: "CVR" }],
    headers: [{ row: 5 }], sections: [{ row: 3, level: "chart" }],
  };
  assert.deepEqual(chartLayout_(ctx, { x: "Date", series: ["CVR"] }), { headerRow: 1, height: 10, cols: [1, 3], row: 4, col: 0 });
  assert.deepEqual(chartLayout_(ctx, { x: "Date", series: ["RPV"], data_from_last_header: true, anchor_section: "chart", position: { col: 6 } }),
    { headerRow: 5, height: 6, cols: [1, 2], row: 3, col: 6 });
  assert.equal(chartLayout_(ctx, { x: "Date", series: ["RPV"], anchor_section: "missing" }), null);
  assert.equal(chartLayout_({ ...ctx, headers: [] }, { x: "Date", series: [], data_from_last_header: true }), null);
});

test("preserveValues_ keeps user columns by row key and blanks missing cells", () => {
  const spec = { header_row: 1, row_key: "Date", columns: [{ name: "Date" }, { name: "Notes", preserve: true }] };
  const old = [["Date", "Notes"], ["2026-09-01", "keep me"], ["2026-09-02"]];
  const next = [["Date", "Notes"], ["2026-09-02", ""], ["2026-09-01", ""], ["2026-09-03", ""]];
  assert.deepEqual(preserveValues_(spec, old, next), [["Date", "Notes"], ["2026-09-02", ""], ["2026-09-01", "keep me"], ["2026-09-03", ""]]);
});
