// The compiler must assemble ONLY the primitives a manifest uses — the proof
// it's a real compiler, not a verbatim copy of a runtime folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAppsScript } from "./compiler.js";

function scaffold(tab) {
  const root = mkdtempSync(join(tmpdir(), "sheetkit-compile-"));
  const artifacts = join(root, "artifacts", "report");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "manifest.json"), JSON.stringify({
    contract_version: 1, spreadsheet_id: "s", tabs: [tab],
  }));
  return { artifacts: join(root, "artifacts"), out: join(root, "out") };
}

const gridColumns = [
  { name: "Date", type: "date", source_field: "date" },
  { name: "RPV", type: "money", source_field: "rpv" },
];

test("charts excluded when no tab uses them, included when one does", () => {
  const noCharts = scaffold({ name: "T", data_key: "t", columns: gridColumns, gradients: [{ column: "RPV", kind: "percentile" }] });
  const r1 = compileAppsScript(noCharts.artifacts, noCharts.out);
  assert.ok(!r1.primitives.includes("chart"), "chart must be absent");
  assert.ok(r1.primitives.includes("gradient"), "gradient must be present");
  const gs1 = readFileSync(join(noCharts.out, "sheetkit.gs"), "utf8");
  assert.ok(!gs1.includes("sk_chart_"), "sk_chart_ must not be emitted");
  assert.ok(gs1.includes("sk_gradient_"), "sk_gradient_ must be emitted");
  assert.ok(gs1.includes("var SK_RENDER_STEPS = ["), "dispatch list generated");

  const withChart = scaffold({ name: "T", data_key: "t", columns: gridColumns, charts: [{ type: "line", x: "Date", series: ["RPV"] }] });
  const r2 = compileAppsScript(withChart.artifacts, withChart.out);
  assert.ok(r2.primitives.includes("chart"), "chart must be present when used");
  assert.ok(readFileSync(join(withChart.out, "sheetkit.gs"), "utf8").includes("sk_chart_"));
});

test("header is always included; invalid manifest throws", () => {
  const ok = scaffold({ name: "T", data_key: "t", columns: gridColumns });
  const r = compileAppsScript(ok.artifacts, ok.out);
  assert.ok(r.primitives.includes("header"), "header always present");

  const bad = scaffold({ name: "T", data_key: "t", columns: [{ name: "X", type: "bogus", source_field: "x" }] });
  assert.throws(() => compileAppsScript(bad.artifacts, bad.out));
});
