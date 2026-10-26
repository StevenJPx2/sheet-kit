import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareSnapshots, compareViaSheetsApi } from "./compare.js";
import { mapSpreadsheet } from "./inspect.js";

function response(id = "A", value = "hello") {
  return {
    spreadsheetId: id,
    properties: { title: `Copy ${id}`, locale: "en_US", timeZone: "UTC" },
    sheets: [{
      properties: { title: "Daily", sheetId: id === "A" ? 1 : 2, gridProperties: { rowCount: 1000, columnCount: 26 } },
      data: [{ rowData: [{ values: [{ userEnteredValue: { stringValue: value }, formattedValue: value }] }] }],
    }],
  };
}

const snapshot = (id = "A") => mapSpreadsheet(response(id), { cells: true });

test("identical copies ignore spreadsheet names and resource ids", () => {
  assert.deepEqual(compareSnapshots(snapshot("A"), snapshot("B")), { identical: true, differences: [] });
});

test("cell diffs include tab, A1 address, field, and both values", () => {
  const left = snapshot(), right = snapshot();
  right.sheets[0].values[0][0] = "changed";
  right.sheets[0].formulas[0][0] = "=1";
  right.sheets[0].backgrounds[0][0] = "#ff0000";
  assert.deepEqual(compareSnapshots(left, right), {
    identical: false,
    differences: [
      { sheet: "Daily", cell: "A1", field: "values", left: "hello", right: "changed" },
      { sheet: "Daily", cell: "A1", field: "formulas", left: "", right: "=1" },
      { sheet: "Daily", cell: "A1", field: "backgrounds", left: "#ffffff", right: "#ff0000" },
    ],
  });
});

test("structure, missing tabs, tab order, locale and extra cells are compared", () => {
  const left = snapshot(), right = snapshot();
  right.locale = "fr_CA";
  right.sheets[0].hidden = true;
  right.sheets[0].merges = ["A1:B1"];
  right.sheets[0].conditional_formats = [{ ranges: ["A:A"], type: "boolean" }];
  right.sheets[0].values.push(["next"]);
  right.sheets.push({ name: "Notes" });
  const { differences } = compareSnapshots(left, right);
  assert.ok(differences.some((d) => d.field === "tab_order"));
  for (const field of ["locale", "hidden", "merges", "conditional_formats"]) assert.ok(differences.some((d) => d.field === field));
  assert.ok(differences.some((d) => d.cell === "A2" && d.left === null && d.right === "next"));
  assert.deepEqual(differences.at(-1), { sheet: "Notes", field: "present", left: false, right: true });
  assert.ok(compareSnapshots(right, left).differences.some((d) => d.field === "present" && d.left === true && d.right === false));
});

test("compare reads both spreadsheets through the API, with optional tab filter and no writes", async () => {
  const calls = [];
  const result = await compareViaSheetsApi("tok", { spreadsheetId: "A", against: "B", sheet: "Daily" }, async (url, init) => {
    const u = new URL(String(url));
    calls.push(u);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer tok");
    assert.equal(u.searchParams.get("ranges"), "'Daily'");
    return Response.json(response(u.pathname.split("/").at(-1)));
  });
  assert.equal(result.identical, true);
  assert.equal(calls.length, 2);
  await assert.rejects(compareViaSheetsApi("tok", { spreadsheetId: "A", against: "B" }, async () => Response.json({ error: { message: "denied" } }, { status: 403 })), /HTTP 403/);
});

test("compare CLI: 0 identical, 1 different/error, 2 missing flags; inspect API and webhook remain available", () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-kit-compare-"));
  const preload = join(dir, "fetch.mjs");
  const config = join(dir, "webhook.json");
  writeFileSync(config, JSON.stringify({ url: "https://script.google.com/test", secret: "s" }));
  writeFileSync(preload, `
    const response = ${response.toString()};
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("script.google.com")) return Response.json({ok:true, spreadsheet:{name:"webhook"}});
      if (process.env.COMPARE_ERROR) return Response.json({error:{message:"denied"}}, {status:403});
      if (init.method !== "GET") throw new Error("unexpected write");
      const id = new URL(url).pathname.split("/").at(-1);
      return Response.json(response(id, id === "DIFF" ? "changed" : "hello"));
    };
  `);
  const cli = (args, env = {}) => spawnSync(process.execPath, ["--import", preload, new URL("./cli.js", import.meta.url).pathname, ...args], {
    encoding: "utf8", env: { ...process.env, SHEET_KIT_ACCESS_TOKEN: "tok", ...env },
  });
  try {
    const same = cli(["compare", "--spreadsheet-id", "A", "--against", "B"]);
    assert.equal(same.status, 0, same.stderr);
    assert.equal(JSON.parse(same.stdout).identical, true);
    const different = cli(["compare", "--spreadsheet-id", "A", "--against", "DIFF", "--sheet", "Daily"]);
    assert.equal(different.status, 1, different.stderr);
    assert.equal(JSON.parse(different.stdout).differences[0].cell, "A1");
    const error = cli(["compare", "--spreadsheet-id", "A", "--against", "B"], { COMPARE_ERROR: "1" });
    assert.equal(error.status, 1);
    assert.match(error.stderr, /HTTP 403/);
    assert.equal(cli(["compare", "--spreadsheet-id", "A"]).status, 2);
    assert.equal(JSON.parse(cli(["inspect", "--spreadsheet-id", "A", "--cells"]).stdout).sheets[0].values[0][0], "hello");
    assert.equal(JSON.parse(cli(["inspect", "--config", config]).stdout).name, "webhook");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
