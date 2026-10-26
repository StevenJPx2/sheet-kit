#!/usr/bin/env node
// sheet-kit CLI — the command layer over the compiler/validator/publisher.
//
//   sheet-kit validate --manifest manifest.json [--data data.json]
//   sheet-kit compile  --artifacts DIR --out DIR [--timezone TZ]
//   sheet-kit deploy   --project DIR [--script-id ID] [--deployment-id ID]
//   sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE] [--full] [--profile]
//   sheet-kit inspect  --spreadsheet-id ID | --config webhook.json  [--sheet NAME] [--range A1] [--cells]
//   sheet-kit auth     login [--account EMAIL] [--expect-domain D] [--no-browser] [--paste] | status | export-env | logout
//   sheet-kit version
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, credentialSource, getAccessToken, isSignedIn, loadToken, login, loginWithPaste, logout, whoami } from "../google/auth.js";
import { inspectViaSheetsApi } from "./inspect.js";
import { compileAppsScript } from "../utils/compiler.js";
import { deployAppsScript } from "./deploy.js";
import { CONTRACT_VERSION, validate } from "../utils/validate.js";
import { checkCoverage, validateData } from "../utils/data.js";
import { loadPublishConfig, publish, requestWebhook } from "./publish.js";
import { cmdSkills } from "./skills.js";

/**
 * Minimal --flag value parser (order-independent).
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
function flags(args) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = "true";
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string[]} args */
function cmdValidate(args) {
  const f = flags(args);
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
function cmdCompile(args) {
  const f = flags(args);
  if (!f.artifacts || !f.out) { process.stderr.write("--artifacts and --out are required\n"); return 2; }

  try {
    const result = compileAppsScript(f.artifacts, f.out, f.timezone ?? "Etc/UTC");
    process.stdout.write(`compiled ${result.tabs} tab(s) to ${result.output} [primitives: ${result.primitives.join(", ")}]\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile: ${String(error)}\n`);
    return 1;
  }
}

/** @param {string[]} args */
function cmdDeploy(args) {
  const f = flags(args);
  if (!f.project) { process.stderr.write("--project is required\n"); return 2; }

  try {
    deployAppsScript({
      projectDir: f.project,
      scriptId: f["script-id"],
      deploymentId: f["deployment-id"],
      description: f.description,
    });
    return 0;
  } catch (error) {
    process.stderr.write(`deploy: ${String(error)}\n`);
    return 1;
  }
}

/** @param {string[]} args */
async function cmdPublish(args) {
  const f = flags(args);
  if (!f.artifact || !f.config) { process.stderr.write("--artifact and --config are required\n"); return 2; }

  let m;
  try { m = readJson(join(f.artifact, "manifest.json")); } catch (e) { process.stderr.write(`manifest: ${String(e)}\n`); return 1; }
  const mErr = validate(m);
  if (mErr) { process.stderr.write(`manifest: ${mErr}\n`); return 1; }

  let d;
  try { d = readJson(join(f.artifact, "data.json")); } catch (e) { process.stderr.write(`data: ${String(e)}\n`); return 1; }
  const cErr = checkCoverage(m, d);
  if (cErr) { process.stderr.write(`coverage: ${cErr}\n`); return 1; }

  const cfg = loadPublishConfig(f.config);
  const opts = { expectedLatest: f["expected-latest"] ?? "", force: f.full === "true", profile: f.profile === "true" };
  const err = await publish(cfg, f.artifact, opts, (msg) => process.stderr.write(msg + "\n"));
  if (err) { process.stderr.write(`publish: ${err}\n`); return 1; }
  process.stdout.write(`published ${m.tabs.length} tab(s)\n`);
  return 0;
}

/**
 * Sheets API when there is a spreadsheet id and a sign-in; otherwise the
 * deployed webhook (--config), which defaults to the manifest's spreadsheet.
 * @param {string[]} args
 */
async function cmdInspect(args) {
  const f = flags(args);
  const spreadsheetId = f["spreadsheet-id"] ?? "";
  const viaApi = Boolean(spreadsheetId) && isSignedIn();
  if (!viaApi && !f.config) {
    process.stderr.write("--spreadsheet-id (signed in via `sheet-kit auth login`) or --config is required\n");
    return 2;
  }

  const opts = { sheet: f.sheet ?? "", range: f.range ?? "", cells: f.cells === "true" };
  try {
    const spreadsheet = viaApi
      ? await inspectViaSheetsApi(await getAccessToken(), { spreadsheetId, ...opts })
      : (await requestWebhook(loadPublishConfig(f.config), { action: "inspect", spreadsheetId, ...opts })).spreadsheet;
    process.stdout.write(JSON.stringify(spreadsheet, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`inspect: ${String(error)}\n`);
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
  const f = flags(rest);
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
    case "compile": return cmdCompile(argv.slice(1));
    case "deploy": return cmdDeploy(argv.slice(1));
    case "publish": return await cmdPublish(argv.slice(1));
    case "inspect": return await cmdInspect(argv.slice(1));
    case "auth": return await cmdAuth(argv.slice(1));
    case "skills": return cmdSkills(argv.slice(1));
    default:
      process.stderr.write("usage: sheet-kit <validate|compile|deploy|publish|inspect|auth|skills|version> [flags]\n");
      return 2;
  }
}

main().then((code) => process.exit(code));
