import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publish } from "./publish.js";

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
    assert.ok(existsSync(join(drive, "manifest.hourly-performance.json")));
    assert.ok(existsSync(join(drive, "data.hourly-performance.json")));
    assert.equal(payload.manifest, "manifest.hourly-performance.json");
    assert.equal(payload.data, "data.hourly-performance.json");
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
