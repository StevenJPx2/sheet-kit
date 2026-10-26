#!/usr/bin/env node
// sheet-kit CLI — validate, publish, inspect and compare through the Sheets API.
//
//   sheet-kit validate --manifest manifest.json [--data data.json]
//   sheet-kit publish  --artifact DIR [--expected-latest DATE]
//   sheet-kit inspect  --spreadsheet-id ID [--sheet NAME] [--range A1] [--cells]
//   sheet-kit compare  --spreadsheet-id ID --against ID [--sheet NAME]
//   sheet-kit auth     login [--account EMAIL] [--expect-domain D] [--no-browser] [--paste] | status | export-env | logout
//   sheet-kit version
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, credentialSource, getAccessToken, loadToken, login, loginWithPaste, logout, whoami } from "../google/auth.js";
import { inspectViaSheetsApi } from "./inspect.js";
import { compareViaSheetsApi } from "./compare.js";
import { CONTRACT_VERSION, validate } from "../utils/validate.js";
import { checkCoverage, validateData } from "../utils/data.js";
import { publish } from "./publish.js";
import { cmdSkills } from "./skills.js";

/**
 * Explicit command flags: reject unknown/missing arguments before side effects.
 * @param {string[]} args
 * @param {string[]} values
 * @param {string[]} [booleans]
 * @returns {Record<string, string>}
 */
function flags(args, values, booleans = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new SyntaxError(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (booleans.includes(key)) { out[key] = "true"; continue; }
    if (!values.includes(key)) throw new SyntaxError(`unknown flag --${key}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) throw new SyntaxError(`--${key} requires a value`);
    out[key] = next;
    i++;
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string[]} args */
function cmdValidate(args) {
  const f = flags(args, ["manifest", "data"]);
  if (!f.manifest) { process.stderr.write("--manifest is required\n"); return 2; }

  let m;
  try { m = readJson(f.manifest); } catch (e) { process.stderr.write(`manifest: ${String(e)}\n`); return 1; }
  const mErr = validate(m);
  if (mErr) { process.stderr.write(`manifest: ${mErr}\n`); return 1; }

  if (f.data) {
    let d;
    try { d = readJson(f.data); } catch (e) { process.stderr.write(`data: ${String(e)}\n`); return 1; }
    const dErr = validateData(d);
    if (dErr) { process.stderr.write(`data: ${dErr}\n`); return 1; }
    const cErr = checkCoverage(m, d);
    if (cErr) { process.stderr.write(`coverage: ${cErr}\n`); return 1; }
  }

  process.stdout.write(`ok: ${m.tabs.length} tab(s), contract v${m.contract_version}\n`);
  return 0;
}

/** @param {string[]} args */
async function cmdPublish(args) {
  const f = flags(args, ["artifact", "expected-latest"]);
  if (!f.artifact) { process.stderr.write("--artifact is required\n"); return 2; }

  let m;
  try { m = readJson(join(f.artifact, "manifest.json")); } catch (e) { process.stderr.write(`manifest: ${String(e)}\n`); return 1; }
  const mErr = validate(m);
  if (mErr) { process.stderr.write(`manifest: ${mErr}\n`); return 1; }

  let d;
  try { d = readJson(join(f.artifact, "data.json")); } catch (e) { process.stderr.write(`data: ${String(e)}\n`); return 1; }
  const dErr = validateData(d);
  if (dErr) { process.stderr.write(`data: ${dErr}\n`); return 1; }
  const cErr = checkCoverage(m, d);
  if (cErr) { process.stderr.write(`coverage: ${cErr}\n`); return 1; }

  try {
    const result = await publish(m, d, { expectedLatest: f["expected-latest"] });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    process.stderr.write(`rendered ${result.tabs.map((t) => t.sheet).join(", ")} (${result.calls} API calls)\n`);
    process.stdout.write(`published ${result.tabs.length} tab(s)\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`publish: ${String(error)}\n`);
    return 1;
  }
}

/** @param {string[]} args */
async function cmdInspect(args) {
  const f = flags(args, ["spreadsheet-id", "sheet", "range"], ["cells"]);
  const spreadsheetId = f["spreadsheet-id"] ?? "";
  if (!spreadsheetId) {
    process.stderr.write("--spreadsheet-id is required\n");
    return 2;
  }

  const opts = { sheet: f.sheet ?? "", range: f.range ?? "", cells: f.cells === "true" };
  try {
    const spreadsheet = await inspectViaSheetsApi(await getAccessToken(), { spreadsheetId, ...opts });
    process.stdout.write(JSON.stringify(spreadsheet, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`inspect: ${String(error)}\n`);
    return 1;
  }
}

/** @param {string[]} args */
async function cmdCompare(args) {
  const f = flags(args, ["spreadsheet-id", "against", "sheet"]);
  if (!f["spreadsheet-id"] || !f.against) {
    process.stderr.write("--spreadsheet-id and --against are required\n");
    return 2;
  }
  try {
    const result = await compareViaSheetsApi(await getAccessToken(), { spreadsheetId: f["spreadsheet-id"], against: f.against, sheet: f.sheet });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.identical ? 0 : 1;
  } catch (error) {
    process.stderr.write(`compare: ${String(error)}\n`);
    return 1;
  }
}

/** @param {string} url */
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const AUTH_USAGE = "usage: sheet-kit auth <login [--account EMAIL] [--expect-domain D] [--no-browser] [--paste] | status | export-env | logout>";

/** @param {string[]} args */
async function cmdAuth(args) {
  const [sub, ...rest] = args;
  const f = flags(rest, ["account", "expect-domain"], ["no-browser", "paste"]);
  const log = (/** @type {string} */ msg) => process.stderr.write(msg + "\n");
  try {
    switch (sub) {
      case "login": {
        const common = { account: f.account, expectDomain: f["expect-domain"] ?? process.env.SHEET_KIT_EXPECT_DOMAIN, log };
        const email = f.paste === "true"
          ? await loginWithPaste({ ...common, readPaste: readStdin })
          : await login({ ...common, openUrl: f["no-browser"] === "true" ? undefined : openBrowser });
        process.stdout.write(`signed in as ${email}\n`);
        return 0;
      }
      case "status": {
        const source = credentialSource();
        if (!source) { process.stdout.write(`not signed in (config: ${configDir()})\n`); return 1; }
        process.stdout.write(`${await whoami(await getAccessToken())} (${source})\n`);
        return 0;
      }
      case "export-env": {
        const t = loadToken();
        if (!t) { log(`auth export-env: not signed in on this machine (config: ${configDir()})`); return 1; }
        log(`# ${t.email}: keep this secret; it grants Drive and Sheets access as that account.`);
        process.stdout.write(`SHEET_KIT_REFRESH_TOKEN=${t.refresh_token}\n`);
        return 0;
      }
      case "logout":
        process.stdout.write((await logout()) ? "signed out\n" : "not signed in\n");
        return 0;
      default:
        log(AUTH_USAGE);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`auth: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case "version": process.stdout.write(`sheet-kit contract v${CONTRACT_VERSION}\n`); return 0;
    case "validate": return cmdValidate(argv.slice(1));
    case "publish": return await cmdPublish(argv.slice(1));
    case "inspect": return await cmdInspect(argv.slice(1));
    case "compare": return await cmdCompare(argv.slice(1));
    case "auth": return await cmdAuth(argv.slice(1));
    case "skills": return cmdSkills(argv.slice(1));
    default:
      process.stderr.write("usage: sheet-kit <validate|publish|inspect|compare|auth|skills|version> [flags]\n");
      return 2;
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = error instanceof SyntaxError ? 2 : 1;
});
