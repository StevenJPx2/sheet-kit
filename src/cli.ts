#!/usr/bin/env node
// sheet-kit CLI — domain-agnostic manifest validation + publish.
//
//   sheet-kit validate --manifest manifest.json [--data data.json]
//   sheet-kit compile  --artifacts DIR --out DIR [--timezone TZ]
//   sheet-kit deploy   --project DIR [--script-id ID] [--deployment-id ID]
//   sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
//   sheet-kit inspect  --config webhook.json [--spreadsheet-id ID] [--sheet NAME] [--range A1] [--cells]
//   sheet-kit version
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileAppsScript } from "./compile.ts";
import { deployAppsScript } from "./deploy.ts";
import { CONTRACT_VERSION, validate, type Manifest } from "./manifest.ts";
import { checkCoverage, validateData, type Data } from "./data.ts";
import { loadPublishConfig, publish, requestWebhook } from "./publish.ts";

/** Minimal --flag value parser (order-independent). */
function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function cmdValidate(args: string[]): number {
  const f = flags(args);
  if (!f.manifest) { process.stderr.write("--manifest is required\n"); return 2; }

  let m: Manifest;
  try { m = readJson<Manifest>(f.manifest); } catch (e) { process.stderr.write(`manifest: ${String(e)}\n`); return 1; }
  const mErr = validate(m);
  if (mErr) { process.stderr.write(`manifest: ${mErr}\n`); return 1; }

  if (f.data) {
    let d: Data;
    try { d = readJson<Data>(f.data); } catch (e) { process.stderr.write(`data: ${String(e)}\n`); return 1; }
    const dErr = validateData(d);
    if (dErr) { process.stderr.write(`data: ${dErr}\n`); return 1; }
    const cErr = checkCoverage(m, d);
    if (cErr) { process.stderr.write(`coverage: ${cErr}\n`); return 1; }
  }

  process.stdout.write(`ok: ${m.tabs.length} tab(s), contract v${m.contract_version}\n`);
  return 0;
}

function cmdCompile(args: string[]): number {
  const f = flags(args);
  if (!f.artifacts || !f.out) { process.stderr.write("--artifacts and --out are required\n"); return 2; }

  try {
    const result = compileAppsScript(f.artifacts, f.out, f.timezone ?? "Etc/UTC");
    process.stdout.write(`compiled ${result.tabs} tab(s) to ${result.output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile: ${String(error)}\n`);
    return 1;
  }
}

function cmdDeploy(args: string[]): number {
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

async function cmdPublish(args: string[]): Promise<number> {
  const f = flags(args);
  if (!f.artifact || !f.config) { process.stderr.write("--artifact and --config are required\n"); return 2; }

  let m: Manifest;
  try { m = readJson<Manifest>(join(f.artifact, "manifest.json")); } catch (e) { process.stderr.write(`manifest: ${String(e)}\n`); return 1; }
  const mErr = validate(m);
  if (mErr) { process.stderr.write(`manifest: ${mErr}\n`); return 1; }

  let d: Data;
  try { d = readJson<Data>(join(f.artifact, "data.json")); } catch (e) { process.stderr.write(`data: ${String(e)}\n`); return 1; }
  const cErr = checkCoverage(m, d);
  if (cErr) { process.stderr.write(`coverage: ${cErr}\n`); return 1; }

  const cfg = loadPublishConfig(f.config);
  const err = await publish(cfg, f.artifact, f["expected-latest"] ?? "", (msg) => process.stderr.write(msg + "\n"));
  if (err) { process.stderr.write(`publish: ${err}\n`); return 1; }
  process.stdout.write(`published ${m.tabs.length} tab(s)\n`);
  return 0;
}

async function cmdInspect(args: string[]): Promise<number> {
  const f = flags(args);
  if (!f.config) { process.stderr.write("--config is required\n"); return 2; }

  try {
    const result = await requestWebhook(loadPublishConfig(f.config), {
      action: "inspect",
      spreadsheetId: f["spreadsheet-id"] ?? "",
      sheet: f.sheet ?? "",
      range: f.range ?? "",
      cells: f.cells === "true",
    });
    process.stdout.write(JSON.stringify(result.spreadsheet, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`inspect: ${String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case "version": process.stdout.write(`sheet-kit contract v${CONTRACT_VERSION}\n`); return 0;
    case "validate": return cmdValidate(argv.slice(1));
    case "compile": return cmdCompile(argv.slice(1));
    case "deploy": return cmdDeploy(argv.slice(1));
    case "publish": return await cmdPublish(argv.slice(1));
    case "inspect": return await cmdInspect(argv.slice(1));
    default:
      process.stderr.write("usage: sheet-kit <validate|compile|deploy|publish|inspect|version> [flags]\n");
      return 2;
  }
}

main().then((code) => process.exit(code));
