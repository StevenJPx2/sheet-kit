import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
