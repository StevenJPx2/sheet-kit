// Node built-in test runner: node --test (or `scriptc run` per-assert).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, formulaRefs, type Manifest } from "./manifest.ts";

function base(): Manifest {
  return {
    contract_version: 1,
    spreadsheet_id: "sheet-abc",
    tabs: [{
      name: "Daily",
      data_key: "daily",
      columns: [
        { name: "Date", type: "date", source_field: "date" },
        { name: "Sessions", type: "integer", source_field: "sessions" },
        { name: "Revenue", type: "money", source_field: "revenue" },
        { name: "RPV", type: "money", formula: "={Revenue}/{Sessions}" },
      ],
      gradients: [{ column: "RPV", kind: "percentile" }],
      charts: [{ type: "line", x: "Date", series: ["RPV"] }],
    }],
  };
}

test("valid manifest passes", () => {
  assert.equal(validate(base()), "");
});

test("formulaRefs extracts names", () => {
  assert.deepEqual(formulaRefs("={Revenue}/{Sessions}"), ["Revenue", "Sessions"]);
  assert.deepEqual(formulaRefs(undefined), []);
});

test("unknown formula ref rejected", () => {
  const m = base();
  m.tabs[0].columns[3].formula = "={Revenue}/{Missing}";
  assert.notEqual(validate(m), "");
});

test("both value sources rejected", () => {
  const m = base();
  m.tabs[0].columns[0].formula = "=1";
  assert.notEqual(validate(m), "");
});

test("bad contract version rejected", () => {
  const m = base();
  m.contract_version = 2;
  assert.notEqual(validate(m), "");
});

test("unknown chart series rejected", () => {
  const m = base();
  m.tabs[0].charts![0].series = ["Nope"];
  assert.notEqual(validate(m), "");
});
