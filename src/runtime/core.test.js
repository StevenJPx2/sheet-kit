// The runtime core is authored as an Apps Script script (globals, no exports).
// We eval it in a vm sandbox to unit-test the pure helpers — the same source the
// compiler emits into the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "core.js"), "utf8"), sandbox);

test("columnName_ produces A1 letters", () => {
  assert.equal(sandbox.columnName_(1), "A");
  assert.equal(sandbox.columnName_(50), "AX");
});

test("resolveFormula_ resolves {Name} to A1 for a row (IFERROR pattern)", () => {
  const columns = [{ name: "Sessions" }, { name: "Revenue" }];
  assert.equal(sandbox.resolveFormula_('=IFERROR({Revenue}/{Sessions},"")', columns, 8), '=IFERROR(B8/A8,"")');
  assert.equal(sandbox.resolveFormula_("={Missing}", columns, 3), "=#REF!");
});

test("rowsToValues_ builds a 2-row grouped header + formula rows", () => {
  const spec = {
    header_row: 2,
    header_merges: [{ from: "C Rev", to: "C Sess", label: "Group" }],
    columns: [
      { name: "C Rev", header: "Rev", source_field: "rev" },
      { name: "C Sess", header: "Sess", source_field: "sess" },
      { name: "RPV", header: "RPV", formula: "={C Rev}/{C Sess}" },
    ],
  };
  const grid = sandbox.rowsToValues_(spec, [{ rev: 10, sess: 5 }]);
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
