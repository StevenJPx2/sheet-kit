import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fakeSheetsApi } from "../render/testing/fake-sheets-api.js";
import { checkExpectedLatest, chooseTransport, publish, publishViaWebhook } from "./publish.js";

const DATA_OBJ = { contract_version: 1, datasets: { daily: [{ date: "2026-09-14", v: 1 }] } };
const DATA = JSON.stringify(DATA_OBJ);
const MANIFEST_OBJ = {
  contract_version: 1,
  spreadsheet_id: "SHEET",
  tabs: [{ name: "Daily", data_key: "daily", columns: [{ name: "Date", type: "date", source_field: "date" }, { name: "V", type: "number", source_field: "v" }] }],
};
const WEBHOOK = { url: "https://script.google.com/macros/s/AKfy/exec", secret: "s3cret" };

function artifactDir() {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-publish-"));
  const dir = join(root, "artifact");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST_OBJ));
  writeFileSync(join(dir, "data.json"), DATA);
  return { root, dir };
}

/** Replace global fetch with a queue of webhook responses; records the parsed bodies. */
async function withFetch(responses, fn) {
  const previous = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    const next = responses.shift() ?? { ok: true };
    return typeof next === "string" ? new Response(next, { status: 500 }) : Response.json(next);
  };
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = previous;
  }
}

const noWait = async () => {};

/** Run publish() with an in-memory Sheets API and a fake webhook. */
async function run(flags, { env, webhook = [], data = DATA_OBJ } = {}) {
  const { root, dir } = artifactDir();
  const api = fakeSheetsApi();
  const logs = [];
  try {
    return await withFetch(webhook, async (bodies) => {
      const error = await publish(
        { manifest: MANIFEST_OBJ, data, artifactDir: dir },
        flags,
        (m) => logs.push(m),
        { env, token: "tok", http: { fetchImpl: api.fetchImpl, wait: noWait }, wait: noWait, readConfig: () => ({ ...WEBHOOK, ...flags.cfg }) },
      );
      return { error, logs, bodies, api, apiCalls: api.book.log.length, root };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("chooseTransport: API without --config; webhook with it; SHEET_KIT_TRANSPORT=api overrides", () => {
  assert.equal(chooseTransport(false, undefined), "api");
  assert.equal(chooseTransport(true, undefined), "webhook");
  assert.equal(chooseTransport(true, "api"), "api");
  assert.equal(chooseTransport(true, "webhook"), "webhook");
  assert.throws(() => chooseTransport(false, "webhook"), /needs --config/);
  assert.throws(() => chooseTransport(false, "drive"), /must be "api" or "webhook"/);
});

test("API path: renders into the manifest's spreadsheet, no webhook call", async () => {
  const r = await run({ full: true });
  assert.equal(r.error, "");
  assert.equal(r.bodies.length, 0);
  assert.equal(r.apiCalls, 4);
  assert.equal(r.api.snapshot().sheets.Daily.cells["1,0"].v, "2026-09-14");
  assert.deepEqual(r.logs, ["rendered Daily:full (4 API calls)"]);
});

test("legacy webhook path with --config: inline data, --full becomes force, deprecation note", async () => {
  const r = await run({ config: "-", full: true }, { webhook: [{ ok: true, tabs: [{ sheet: "Daily", mode: "full" }] }] });
  assert.equal(r.error, "");
  assert.equal(r.apiCalls, 0);
  assert.deepEqual(r.bodies, [{ token: "s3cret", dataInline: DATA, force: true, profile: false }]);
  assert.match(r.logs[0], /webhook transport is deprecated/);
  assert.equal(r.logs[1], "rendered Daily:full");
});

test("SHEET_KIT_TRANSPORT=api with --config renders through the API and ignores the webhook, with one note", async () => {
  const r = await run({ config: "-", full: true }, { env: "api" });
  assert.equal(r.error, "");
  assert.equal(r.bodies.length, 0, "no webhook call");
  assert.equal(r.apiCalls, 4);
  assert.deepEqual(r.logs.filter((l) => l.startsWith("note:")), ["note: SHEET_KIT_TRANSPORT=api: rendering through the Sheets API; the webhook config is ignored"]);
});

test("a driveDir in the config is ignored with one note and nothing is staged", async () => {
  const drive = join(tmpdir(), `sheet-kit-drive-${process.pid}`);
  const r = await run({ config: "-", cfg: { driveDir: drive } });
  assert.equal(r.error, "");
  assert.equal(existsSync(drive), false);
  assert.equal(r.logs.filter((l) => /driveDir is ignored/.test(l)).length, 1);
  assert.equal(r.bodies.length, 1);
});

test("--expected-latest: passes when data reaches the date, refuses stale data on either transport", async () => {
  assert.equal(checkExpectedLatest(DATA_OBJ, "2026-09-14"), "");
  assert.equal(checkExpectedLatest(DATA_OBJ, undefined), "");
  assert.match(checkExpectedLatest(DATA_OBJ, "14/09/2026"), /YYYY-MM-DD/);
  assert.match(checkExpectedLatest({ datasets: { x: [{ n: 1 }] } }, "2026-09-14"), /newest date is \(none\)/);

  for (const flags of [{ expectedLatest: "2026-09-15" }, { config: "-", expectedLatest: "2026-09-15" }]) {
    const r = await run(flags);
    assert.equal(r.error, "data.json is stale: its newest date is 2026-09-14, expected 2026-09-15 or later");
    assert.equal(r.bodies.length + r.apiCalls, 0, "nothing is rendered");
  }
  assert.equal((await run({ expectedLatest: "2026-09-14" })).error, "");
});

test("an API error is reported, not swallowed", async () => {
  const r = await run({}, { data: { contract_version: 1, datasets: { daily: [] } } });
  assert.equal(r.error, "");
  const { root, dir } = artifactDir();
  try {
    const err = await publish(
      { manifest: { ...MANIFEST_OBJ, spreadsheet_id: "MISSING" }, data: DATA_OBJ, artifactDir: dir }, {}, () => {},
      { token: "tok", http: { fetchImpl: fakeSheetsApi().fetchImpl, wait: noWait } },
    );
    assert.match(err, /HTTP 404/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the webhook's HTML error page is retried, then the render succeeds", async () => {
  const { root, dir } = artifactDir();
  try {
    await withFetch(["<!DOCTYPE html>busy", "<!DOCTYPE html>busy", { ok: true }], async (bodies) => {
      const logs = [];
      assert.equal(await publishViaWebhook(WEBHOOK, dir, {}, (m) => logs.push(m), { wait: noWait }), "");
      assert.equal(bodies.length, 3);
      assert.match(logs[0], /non-JSON webhook response \(HTTP 500\); retry 1\/5/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("webhook import errors are retried three times, then reported", async () => {
  const { root, dir } = artifactDir();
  const err = { ok: false, error: "Service Spreadsheets timed out" };
  try {
    await withFetch([err, err, err, err], async (bodies) => {
      assert.equal(await publishViaWebhook(WEBHOOK, dir, {}, () => {}, { wait: noWait }), "webhook rejected import after 3 retries: Service Spreadsheets timed out");
      assert.equal(bodies.length, 4);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run the real CLI with fetch stubbed by a preload; stderr carries "BODY <json>" per request. */
function cli(args, { input, env = {}, root }) {
  const stub = join(root, "stub-fetch.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url, init) => {
    process.stderr.write("CALL " + url + " " + (init?.body ?? "") + "\\n");
    if (String(url).includes("script.google.com")) return Response.json({ ok: true, tabs: [{ sheet: "Daily", mode: "full" }] });
    if (String(url).includes(":batchUpdate")) return Response.json({});
    return Response.json({ sheets: [{ properties: { sheetId: 0, title: "Daily", gridProperties: { rowCount: 1000, columnCount: 26 } } }] });
  };\n`);
  const cliPath = new URL("./cli.js", import.meta.url).pathname;
  return spawnSync(process.execPath, ["--import", stub, cliPath, ...args], {
    input, encoding: "utf8",
    env: { ...process.env, SHEET_KIT_ACCESS_TOKEN: "tok", SHEET_KIT_TRANSPORT: "", ...env },
  });
}

test("mpd's call works unchanged: publish --artifact OUT --config - --expected-latest DATE --full", () => {
  const { root, dir } = artifactDir();
  const config = { ...WEBHOOK, driveDir: join(root, "drive") };
  try {
    const result = cli(["publish", "--artifact", dir, "--config", "-", "--expected-latest", "2026-09-14", "--full"], { input: JSON.stringify(config), root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "published 1 tab(s)\n");
    const calls = result.stderr.split("\n").filter((l) => l.startsWith("CALL "));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^CALL https:\/\/script\.google\.com\/macros\/s\/AKfy\/exec /);
    assert.deepEqual(JSON.parse(calls[0].replace(/^CALL \S+ /, "")), { token: "s3cret", dataInline: DATA, force: true, profile: false });
    assert.match(result.stderr, /note: driveDir is ignored/);
    assert.equal(existsSync(config.driveDir), false);

    const switched = cli(["publish", "--artifact", dir, "--config", "-", "--expected-latest", "2026-09-14", "--full"], { input: JSON.stringify(config), root, env: { SHEET_KIT_TRANSPORT: "api" } });
    assert.equal(switched.status, 0, switched.stderr);
    const apiCalls = switched.stderr.split("\n").filter((l) => l.startsWith("CALL "));
    assert.ok(apiCalls.length >= 3 && apiCalls.every((l) => l.includes("sheets.googleapis.com/v4/spreadsheets/SHEET")), switched.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publish --artifact DIR (no --config) renders through the API", () => {
  const { root, dir } = artifactDir();
  try {
    const result = cli(["publish", "--artifact", dir], { root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "published 1 tab(s)\n");
    assert.doesNotMatch(result.stderr, /script\.google\.com/);
    assert.match(result.stderr, /rendered Daily:full \(4 API calls\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
