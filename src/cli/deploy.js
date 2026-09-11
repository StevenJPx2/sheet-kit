import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {Object} DeployOptions
 * @property {string}  projectDir
 * @property {string} [scriptId]
 * @property {string} [deploymentId]
 * @property {string} [description]
 */

/**
 * Push a compiled Apps Script project and (re)deploy it via clasp.
 * @param {DeployOptions} options
 */
export function deployAppsScript(options) {
  const manifest = join(options.projectDir, "appsscript.json");
  if (!existsSync(manifest)) throw new Error(`missing generated Apps Script manifest: ${manifest}`);

  if (options.scriptId) {
    const clasp = { scriptId: options.scriptId, rootDir: "." };
    writeFileSync(join(options.projectDir, ".clasp.json"), `${JSON.stringify(clasp, null, 2)}\n`);
  }
  if (!existsSync(join(options.projectDir, ".clasp.json"))) {
    throw new Error("missing .clasp.json; pass --script-id on the first deploy");
  }

  runClasp(options.projectDir, ["push", "--force"]);

  const args = ["deploy"];
  if (options.deploymentId) args.push("--deploymentId", options.deploymentId);
  if (options.description) args.push("--description", options.description);
  runClasp(options.projectDir, args);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runClasp(cwd, args) {
  const result = spawnSync("npx", ["--yes", "@google/clasp", ...args], { cwd, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`clasp ${args[0]} failed (${result.status ?? "signal"})`);
}
