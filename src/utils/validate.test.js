import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, formulaRefs } from "./validate.js";

function base() {
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

test("gradient primitive owns its schema (unknown group_by rejected)", () => {
  const m = base();
  m.tabs[0].gradients[0].group_by = "Nope";
  assert.notEqual(validate(m), "");
  m.tabs[0].gradients[0].group_by = "Date";
  assert.equal(validate(m), "");
});

test("chart primitive owns its schema (unknown series rejected)", () => {
  const m = base();
  m.tabs[0].charts[0].series = ["Nope"];
  assert.notEqual(validate(m), "");
});

test("chart requires a series", () => {
  const m = base();
  m.tabs[0].charts[0].series = [];
  assert.notEqual(validate(m), "");
});

test("placement primitive owns its schema", () => {
  const m = base();
  m.tabs[0].placement = { position: "last", hidden: true };
  assert.equal(validate(m), "");
  m.tabs[0].placement = { position: "middle" };
  assert.match(validate(m), /placement.position/);
  m.tabs[0].placement = { hidden: "yes" };
  assert.match(validate(m), /placement.hidden/);
});

test("duplicate tab names and data keys are rejected", () => {
  const named = base();
  named.tabs.push({ ...named.tabs[0], data_key: "other" });
  assert.match(validate(named), /duplicate tab name/);

  const keyed = base();
  keyed.tabs.push({ ...keyed.tabs[0], name: "Other" });
  assert.match(validate(keyed), /duplicate data_key/);
});

test("preserved columns require a valid row key", () => {
  const m = base();
  m.tabs[0].columns.push({ name: "Notes", type: "string", preserve: true });
  assert.notEqual(validate(m), "");
  m.tabs[0].row_key = "Date";
  assert.equal(validate(m), "");
});
