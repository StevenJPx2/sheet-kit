// The runtime core is authored as an Apps Script script (globals, no exports).
// We eval it in a vm sandbox to unit-test the pure helpers — the same source the
// compiler emits into the bundle (grid.js with exports stripped + core.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { appsScriptCore } from "../utils/compiler.js";

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(appsScriptCore(), sandbox);

test("columnName_ produces A1 letters", () => {
  assert.equal(sandbox.columnName_(1), "A");
  assert.equal(sandbox.columnName_(50), "AX");
});

test("buildGrid_ emits merged section + repeated header rows and keeps formula A1 correct", () => {
  const spec = {
    header_row: 1,
    columns: [
      { name: "Rank", header: "Rank", source_field: "rank" },
      { name: "RPV", header: "RPV", formula: "={Rank}" },
    ],
  };
  const rows = [
    { __section__: "Previous day — 2026-09-10", __level: "period" },
    { __header__: true },
    { rank: 1 },
    { __section__: "7-day", __level: "period" },
    { rank: 2 },
  ];
  const built = sandbox.buildGrid_(spec, rows);
  // grid: [colHeader, section, repeatedHeader, data(rank1), section, data(rank2)]
  assert.equal(built.values.length, 6);
  assert.equal(built.values[1][0], "Previous day — 2026-09-10");
  assert.equal(built.values[2][0], "Rank"); // repeated header
  // section rows are 1-based sheet rows 2 and 5; header repeat is row 3
  assert.equal(JSON.stringify(built.sections.map((s) => s.row)), JSON.stringify([2, 5]));
  assert.equal(JSON.stringify(built.headers.map((h) => h.row)), JSON.stringify([3]));
  // the rank-1 data row is sheet row 4 → its RPV formula must resolve {Rank}→A4
  assert.equal(built.values[3][1], "=A4");
  // the rank-2 data row is sheet row 6 → A6
  assert.equal(built.values[5][1], "=A6");
});

test("buildGrid_ resolves a formula section heading against its block's next data row", () => {
  const spec = {
    header_row: 1,
    columns: [
      { name: "Date", header: "Date", source_field: "date" },
      { name: "p", header: "p", source_field: "p" },
    ],
  };
  const rows = [
    { __section__: "Experiment: A", __level: "experiment" },
    { __section__: '=IF({p}<0.2,"YES","no")', __level: "significance" },
    { date: "cum", p: 0.03 },
    { date: "2026-09-04", p: 0.5 },
  ];
  const grid = sandbox.buildGrid_(spec, rows).values;
  // grid: [colHeader, titleSection, statsigSection, cumRow(4), dailyRow(5)]
  // statsig heading must resolve {p} to the cumulative row (sheet row 4) → B4.
  assert.equal(grid[2][0], '=IF(B4<0.2,"YES","no")');
  assert.equal(grid[1][0], "Experiment: A"); // plain text heading untouched
});

test("resolveFormula_ resolves {Name} to A1 for a row (IFERROR pattern)", () => {
  const columns = [{ name: "Sessions" }, { name: "Revenue" }];
  assert.equal(sandbox.resolveFormula_('=IFERROR({Revenue}/{Sessions},"")', columns, 8), '=IFERROR(B8/A8,"")');
  assert.equal(sandbox.resolveFormula_("={Missing}", columns, 3), "=#REF!");
});

test("buildGrid_ builds a 2-row grouped header + formula rows", () => {
  const spec = {
    header_row: 2,
    header_merges: [{ from: "C Rev", to: "C Sess", label: "Group" }],
    columns: [
      { name: "C Rev", header: "Rev", source_field: "rev" },
      { name: "C Sess", header: "Sess", source_field: "sess" },
      { name: "RPV", header: "RPV", formula: "={C Rev}/{C Sess}" },
    ],
  };
  const grid = sandbox.buildGrid_(spec, [{ rev: 10, sess: 5 }]).values;
  assert.equal(grid.length, 3); // group header + column header + 1 data row
  assert.equal(grid[0][0], "Group");
  assert.equal(JSON.stringify(grid[1]), JSON.stringify(["Rev", "Sess", "RPV"]));
  assert.equal(grid[2][2], "=A3/B3");
});

test("gradientRuns_ splits into runs per group value", () => {
  const columns = [{ name: "Section" }, { name: "RPV" }];
  const values = [
    ["Section", "RPV"],
    ["A", 1], ["A", 2], ["B", 3],
  ];
  const runs = sandbox.gradientRuns_(values, columns, 2, 3, "Section");
  assert.equal(JSON.stringify(runs), JSON.stringify([{ firstRow: 2, rowCount: 2 }, { firstRow: 4, rowCount: 1 }]));
  const whole = sandbox.gradientRuns_(values, columns, 2, 3, undefined);
  assert.equal(JSON.stringify(whole), JSON.stringify([{ firstRow: 2, rowCount: 3 }]));
});

test("matchLabel_ handles empty/prefix/equals", () => {
  assert.ok(sandbox.matchLabel_("", { empty: true }));
  assert.ok(sandbox.matchLabel_("July cumulative", { suffix: "cumulative" }));
  assert.ok(!sandbox.matchLabel_("July cumulative", { empty: true }));
});

test("layoutSignature_ ignores cell numbers but tracks everything styling reads", () => {
  const spec = {
    header_row: 1,
    columns: [
      { name: "Date", header: "Date", source_field: "date" },
      { name: "Status", header: "", source_field: "status" },
      { name: "RPV", header: "RPV", source_field: "rpv" },
    ],
    row_label_styles: [
      { match: { column: "Date", suffix: "cumulative" }, style: { bold: true, background: "#d9eaf7" } },
      { match: { column: "Status", equals: "🟢" }, style: { background: "#e6f4ea" } },
    ],
    gradients: [{ column: "RPV", kind: "percentile", group_by: "Date" }],
  };
  const sig = (rows) => {
    const built = sandbox.buildGrid_(spec, rows);
    return sandbox.layoutSignature_(spec, sandbox.normalizeWidth_(built.values), built, 1);
  };
  const base = [
    { __section__: "Block", __level: "block" },
    { date: "Rolling 7 days (Sep 10 - Sep 16) cumulative", status: "🟢", rpv: 4.1 },
    { date: "2026-09-16", status: "🟢", rpv: 2.36 },
  ];
  // Numbers change, label text changes (still matches "cumulative") → SAME layout.
  const sameLayout = [
    { __section__: "Block", __level: "block" },
    { date: "Rolling 7 days (Sep 11 - Sep 17) cumulative", status: "🟢", rpv: 9.9 },
    { date: "2026-09-17", status: "🟢", rpv: 0 },
  ];
  assert.equal(sig(base), sig(sameLayout));

  // A status light flips → rowLabel match bitmap differs → DIFFERENT.
  const flipped = JSON.parse(JSON.stringify(base));
  flipped[2].status = "🔴";
  assert.notEqual(sig(base), sig(flipped));

  // A row is added → dimensions differ → DIFFERENT.
  assert.notEqual(sig(base), sig(base.concat([{ date: "2026-09-15", status: "🟢", rpv: 1 }])));

  // A section heading moves/changes level → DIFFERENT.
  const moved = JSON.parse(JSON.stringify(base));
  moved[0].__level = "note";
  assert.notEqual(sig(base), sig(moved));

  // Gradient group_by run boundaries change (same row count) → DIFFERENT.
  const regrouped = JSON.parse(JSON.stringify(base));
  regrouped[2].date = regrouped[1].date; // both rows now one run
  assert.notEqual(sig(base), sig(regrouped));
});

test("diffState_ picks values / partial / full from the per-step state", () => {
  const regionOf = (n) => ({ sk_rowLabel_: "format", sk_gradient_: "cf", sk_freeze_: "sheet", sk_mystery_: null })[n];
  const base = { v: 2, rows: 10, width: 5, headerRows: 1, steps: { sk_rowLabel_: "a", sk_gradient_: "b", sk_freeze_: "c" } };
  const same = JSON.parse(JSON.stringify(base));
  assert.equal(sandbox.diffState_(base, same, regionOf).mode, "values");
  // no previous state → full
  assert.equal(sandbox.diffState_(null, base, regionOf).mode, "full");
  // width or header rows changed → full (column positions shift)
  assert.equal(sandbox.diffState_(base, { ...same, width: 6 }, regionOf).mode, "full");
  assert.equal(sandbox.diffState_(base, { ...same, headerRows: 2 }, regionOf).mode, "full");
  // one format step dirty → partial, only the format region
  const flip = JSON.parse(JSON.stringify(base)); flip.steps.sk_rowLabel_ = "z";
  const plan = sandbox.diffState_(base, flip, regionOf);
  assert.equal(plan.mode, "partial");
  assert.equal(JSON.stringify(plan.regions), JSON.stringify({ format: true }));
  assert.equal(JSON.stringify(plan.dirty), JSON.stringify(["sk_rowLabel_"]));
  // row count changed but no step dirty → partial (content of vanished rows must be cleared)
  assert.equal(sandbox.diffState_(base, { ...same, rows: 9 }, regionOf).mode, "partial");
  // a dirty step with no declared region → full (unknown footprint)
  const odd = JSON.parse(JSON.stringify(base)); odd.steps.sk_mystery_ = "q";
  const prevOdd = JSON.parse(JSON.stringify(base)); prevOdd.steps.sk_mystery_ = "p";
  assert.equal(sandbox.diffState_(prevOdd, odd, regionOf).mode, "full");
});
