import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeSheetsApi } from "../render/testing/fake-sheets-api.js";
import { checkExpectedLatest, dataLatestDate, publish } from "./publish.js";

const DATA = { contract_version: 1, datasets: { daily: [{ date: "2026-09-14", v: 1 }] } };
const MANIFEST = {
  contract_version: 1, spreadsheet_id: "SHEET",
  tabs: [{ name: "Daily", data_key: "daily", columns: [{ name: "Date", type: "date", source_field: "date" }, { name: "V", type: "number", source_field: "v" }] }],
};

test("publish renders into the manifest's spreadsheet through the API", async () => {
  const api = fakeSheetsApi();
  const result = await publish(MANIFEST, DATA, { token: "tok", http: { fetchImpl: api.fetchImpl } });
  assert.equal(result.calls, 4);
  assert.deepEqual(result.tabs, [{ sheet: "Daily", rows: 2 }]);
  assert.equal(api.snapshot().sheets.Daily.cells["1,0"].v, "2026-09-14");
  assert.ok(api.book.log.every((c) => c.path.startsWith("/v4/spreadsheets/SHEET")));
});

test("expected-latest rejects stale, absent and malformed dates before credentials or writes", async () => {
  assert.equal(checkExpectedLatest(DATA, "2026-09-14"), "");
  assert.equal(checkExpectedLatest(DATA, undefined), "");
  assert.match(checkExpectedLatest(DATA, "14/09/2026"), /YYYY-MM-DD/);
  assert.match(checkExpectedLatest({ datasets: { x: [{ n: 1 }] } }, "2026-09-14"), /newest date is \(none\)/);
  const noFetch = async () => { throw new Error("unexpected network call"); };
  await assert.rejects(publish(MANIFEST, DATA, { expectedLatest: "2026-09-15", http: { fetchImpl: noFetch } }), /data.json is stale/);
  const api = fakeSheetsApi();
  await publish(MANIFEST, DATA, { expectedLatest: "2026-09-14", token: "tok", http: { fetchImpl: api.fetchImpl } });
  assert.equal(api.book.log.length, 4);
});

test("latest date is the maximum exact ISO string across every dataset", () => {
  assert.equal(dataLatestDate({ datasets: {
    a: [{ date: "2026-09-14" }, { label: "Week 2026-09-20" }],
    b: [{ day: "2026-09-16" }, { value: 20260930 }],
  } }), "2026-09-16");
});

test("API failures propagate without a fallback transport", async () => {
  const api = fakeSheetsApi();
  await assert.rejects(publish({ ...MANIFEST, spreadsheet_id: "MISSING" }, DATA, { token: "tok", http: { fetchImpl: api.fetchImpl } }), /HTTP 404/);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-publish-"));
  const dir = join(root, "artifact");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, "data.json"), JSON.stringify(DATA));
  const stub = join(root, "fetch.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://sheets.googleapis.com/v4/spreadsheets/SHEET")) throw new Error("unexpected URL");
    process.stderr.write("CALL " + url + " " + (init?.body ?? "") + "\\n");
    if (String(url).includes(":batchUpdate")) return Response.json({});
    return Response.json({sheets:[{properties:{sheetId:0,title:"Daily",gridProperties:{rowCount:1000,columnCount:26}}}]});
  };`);
  const cli = (args) => spawnSync(process.execPath, ["--import", stub, new URL("./cli.js", import.meta.url).pathname, ...args], {
    encoding: "utf8", env: { ...process.env, SHEET_KIT_ACCESS_TOKEN: "tok" },
  });
  return { root, dir, cli };
}

test("publish CLI reads both files and writes directly without compile or deploy", () => {
  const { root, dir, cli } = fixture();
  try {
    const result = cli(["publish", "--artifact", dir, "--expected-latest", "2026-09-14"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "published 1 tab(s)\n");
    assert.match(result.stderr, /rendered Daily \(4 API calls\)/);
    const calls = result.stderr.split("\n").filter((l) => l.startsWith("CALL "));
    assert.equal(calls.length, 4);
    const values = calls.find((l) => l.includes("/values:batchUpdate"));
    assert.deepEqual(JSON.parse(values.replace(/^CALL \S+ /, "")).data[0].values, [["Date", "V"], ["2026-09-14", 1]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publish CLI rejects invalid artifacts and stale dates without network calls", () => {
  const { root, dir, cli } = fixture();
  try {
    const stale = cli(["publish", "--artifact", dir, "--expected-latest", "2026-09-15"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale/);
    assert.doesNotMatch(stale.stderr, /CALL /);
    writeFileSync(join(dir, "data.json"), JSON.stringify({ contract_version: 1 }));
    const invalid = cli(["publish", "--artifact", dir]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /datasets is required/);
    assert.doesNotMatch(invalid.stderr, /CALL /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
