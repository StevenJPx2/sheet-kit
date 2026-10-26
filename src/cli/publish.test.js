import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publish } from "./publish.js";

const DATA = JSON.stringify({ contract_version: 1, datasets: { daily: [{ date: "2026-09-14", v: 1 }] } });
const MANIFEST = JSON.stringify({
  contract_version: 1,
  spreadsheet_id: "s",
  tabs: [{ name: "Daily", data_key: "daily", columns: [{ name: "Date", type: "date", source_field: "date" }, { name: "V", type: "number", source_field: "v" }] }],
});

function artifact() {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-publish-"));
  const dir = join(root, "artifact");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), MANIFEST);
  writeFileSync(join(dir, "data.json"), DATA);
  return { root, dir };
}

/** Replace global fetch with a queue of responses; records the parsed bodies. */
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

const noWait = { wait: async () => {} };

test("loadPublishConfig reads stdin when path is dash", () => {
  const script = `
    import { loadPublishConfig } from ${JSON.stringify(new URL("./publish.js", import.meta.url).href)};
    process.stdout.write(JSON.stringify(loadPublishConfig("-")));
  `;
  const config = { url: "https://example.com", secret: "x", driveDir: "/tmp" };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify(config), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), config);
});

test("publish sends data.json inline and nothing else about Drive", async () => {
  const { root, dir } = artifact();
  try {
    await withFetch([{ ok: true, tabs: [{ sheet: "Daily", mode: "values" }] }], async (bodies) => {
      const logs = [];
      const error = await publish({ url: "https://example.com", secret: " x " }, dir, { force: true }, (m) => logs.push(m), noWait);
      assert.equal(error, "");
      assert.deepEqual(bodies, [{ token: "x", dataInline: DATA, force: true, profile: false }]);
      assert.deepEqual(logs, ["rendered Daily:values"]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a driveDir in the config is ignored with one deprecation note", async () => {
  const { root, dir } = artifact();
  const drive = join(root, "drive");
  try {
    await withFetch([], async (bodies) => {
      const logs = [];
      const error = await publish({ url: "https://example.com", secret: "x", driveDir: drive }, dir, {}, (m) => logs.push(m), noWait);
      assert.equal(error, "");
      assert.equal(existsSync(drive), false, "nothing is staged to Drive");
      assert.deepEqual(logs, ["note: driveDir is ignored; publish sends data inline (Drive staging was removed)"]);
      assert.equal(bodies.length, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--expected-latest is accepted as a no-op with a note (option and legacy string)", async () => {
  const { root, dir } = artifact();
  try {
    for (const options of [{ expectedLatest: "2026-09-15" }, "2026-09-15"]) {
      await withFetch([], async (bodies) => {
        const logs = [];
        const error = await publish({ url: "https://example.com", secret: "x" }, dir, options, (m) => logs.push(m), noWait);
        assert.equal(error, "", "a date newer than the data must not block: inline data cannot be stale");
        assert.match(logs[0], /--expected-latest is no longer needed/);
        assert.equal("expectedLatest" in bodies[0], false);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Apps Script HTML error page is retried, then the render succeeds", async () => {
  const { root, dir } = artifact();
  try {
    await withFetch(["<!DOCTYPE html>busy", "<!DOCTYPE html>busy", { ok: true }], async (bodies) => {
      const logs = [];
      assert.equal(await publish({ url: "https://example.com", secret: "x" }, dir, {}, (m) => logs.push(m), noWait), "");
      assert.equal(bodies.length, 3);
      assert.match(logs[0], /non-JSON webhook response \(HTTP 500\); retry 1\/5/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import errors are retried three times, then reported", async () => {
  const { root, dir } = artifact();
  const err = { ok: false, error: "Service Spreadsheets timed out" };
  try {
    await withFetch([err, err, err, err], async (bodies) => {
      const error = await publish({ url: "https://example.com", secret: "x" }, dir, {}, () => {}, noWait);
      assert.equal(error, "webhook rejected import after 3 retries: Service Spreadsheets timed out");
      assert.equal(bodies.length, 4);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mpd's call works unchanged: publish --artifact OUT --config - --expected-latest DATE --full", () => {
  const { root, dir } = artifact();
  // Preload that stubs fetch in the CLI process and echoes the request body.
  const stub = join(root, "stub-fetch.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url, init) => {
    process.stderr.write("BODY " + init.body + "\\n");
    return Response.json({ ok: true, tabs: [{ sheet: "Daily", mode: "full" }] });
  };\n`);
  const cli = new URL("./cli.js", import.meta.url).pathname;
  const config = { url: "https://script.google.com/macros/s/AKfy/exec", secret: "s3cret", driveDir: join(root, "drive") };
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", stub, cli, "publish", "--artifact", dir, "--config", "-", "--expected-latest", "2026-09-14", "--full"],
      { input: JSON.stringify(config), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "published 1 tab(s)\n");
    const body = JSON.parse(result.stderr.split("\n").find((l) => l.startsWith("BODY ")).slice(5));
    assert.deepEqual(body, { token: "s3cret", dataInline: DATA, force: true, profile: false });
    assert.match(result.stderr, /note: driveDir is ignored/);
    assert.match(result.stderr, /note: --expected-latest is no longer needed/);
    assert.equal(existsSync(config.driveDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
