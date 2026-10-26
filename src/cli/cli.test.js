import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function cli(args) {
  return spawnSync(process.execPath, [new URL("./cli.js", import.meta.url).pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, SHEET_KIT_ACCESS_TOKEN: "", SHEET_KIT_REFRESH_TOKEN: "" },
  });
}

test("unsupported commands and flags fail before any file, network or process work", () => {
  for (const command of ["compile", "deploy"]) {
    const result = cli([command]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: sheet-kit <validate\|publish\|inspect\|compare\|auth\|skills\|version>/);
  }
  for (const [command, flag] of [["publish", "config"], ["publish", "full"], ["publish", "profile"], ["inspect", "config"]]) {
    const result = cli([command, `--${flag}`, "unused"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`unknown flag --${flag}`));
    assert.equal(result.stdout, "");
  }
});

test("inspect and publish require explicit targets", () => {
  assert.match(cli(["inspect"]).stderr, /--spreadsheet-id is required/);
  assert.match(cli(["publish"]).stderr, /--artifact is required/);
});
