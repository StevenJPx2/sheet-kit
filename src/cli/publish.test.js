import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publish, stageWithRetry } from "./publish.js";

test("loadPublishConfig reads stdin when path is dash", () => {
  const script = `
    import { loadPublishConfig } from ${JSON.stringify(new URL("./publish.js", import.meta.url).href)};
    process.stdout.write(JSON.stringify(loadPublishConfig("-")));
  `;
  const config = { url: "https://example.com", secret: "x", driveDir: "/tmp" };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(config),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), config);
});

test("publish stages dataset-specific files", async () => {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-publish-"));
  const artifact = join(root, "artifact");
  const drive = join(root, "drive");
  mkdirSync(artifact);
  writeFileSync(join(artifact, "manifest.json"), "{}\n");
  writeFileSync(join(artifact, "data.json"), JSON.stringify({ datasets: { "hourly-performance": [] } }));

  const previousFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const error = await publish({ url: "https://example.com", secret: "x", driveDir: drive }, artifact, "", () => {});
    assert.equal(error, "");
    assert.ok(existsSync(join(drive, "data.hourly-performance.json")));
    assert.equal(payload.data, "data.hourly-performance.json");
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stageWithRetry retries the transient Drive copy error, then succeeds", async () => {
  let calls = 0;
  const copy = () => {
    calls++;
    if (calls < 3) throw new Error("Unknown system error -11");
  };
  await stageWithRetry("src", "dest", copy, async () => {});
  assert.equal(calls, 3);
});

test("stageWithRetry gives up and throws after 8 attempts", async () => {
  let calls = 0;
  const copy = () => {
    calls++;
    throw new Error("Unknown system error -11");
  };
  await assert.rejects(stageWithRetry("src", "dest", copy, async () => {}), /-11/);
  assert.equal(calls, 8);
});
