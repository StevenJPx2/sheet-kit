import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileAppsScript } from "./compile.ts";

test("compile emits a self-contained Apps Script project", () => {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-compile-"));
  const artifacts = join(root, "artifacts");
  const output = join(root, "generated");

  mkdirSync(join(artifacts, "first"), { recursive: true });
  mkdirSync(join(artifacts, "second"), { recursive: true });
  writeFileSync(join(artifacts, "first", "manifest.json"), JSON.stringify({
    contract_version: 1,
    spreadsheet_id: "sheet-id",
    tabs: [{ name: "First", data_key: "first", columns: [{ name: "Date", type: "date", source_field: "date" }] }],
  }));
  writeFileSync(join(artifacts, "second", "manifest.json"), JSON.stringify({
    contract_version: 1,
    spreadsheet_id: "sheet-id",
    tabs: [{ name: "Second", data_key: "second", columns: [{ name: "Name", type: "string", source_field: "name" }] }],
  }));

  const result = compileAppsScript(artifacts, output, "America/Los_Angeles");

  assert.equal(result.tabs, 2);
  assert.match(readFileSync(join(output, "manifest.gs"), "utf8"), /"First"/);
  assert.match(readFileSync(join(output, "manifest.gs"), "utf8"), /"Second"/);
  assert.match(readFileSync(join(output, "sheetkit.gs"), "utf8"), /function renderTab/);
  assert.match(readFileSync(join(output, "webhook.gs"), "utf8"), /function doPost/);
  assert.equal(JSON.parse(readFileSync(join(output, "appsscript.json"), "utf8")).timeZone, "America/Los_Angeles");
});

test("compile rejects manifests for different spreadsheets", () => {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-compile-"));
  const artifacts = join(root, "artifacts");

  for (const [name, spreadsheet] of [["first", "one"], ["second", "two"]]) {
    mkdirSync(join(artifacts, name), { recursive: true });
    writeFileSync(join(artifacts, name, "manifest.json"), JSON.stringify({
      contract_version: 1,
      spreadsheet_id: spreadsheet,
      tabs: [{ name, data_key: name, columns: [{ name: "ID", type: "string", source_field: "id" }] }],
    }));
  }

  assert.throws(() => compileAppsScript(artifacts, join(root, "generated")), /same spreadsheet_id/);
});
