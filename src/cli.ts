#!/usr/bin/env node
// sheet-kit CLI — domain-agnostic manifest validation + publish.
//
//   sheet-kit validate --manifest manifest.json [--data data.json]
//   sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
//   sheet-kit version
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION, validate, type Manifest } from "./manifest.ts";
import { checkCoverage, validateData, type Data } from "./data.ts";
import { loadPublishConfig, publish } from "./publish.ts";

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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case "version": process.stdout.write(`sheet-kit contract v${CONTRACT_VERSION}\n`); return 0;
    case "validate": return cmdValidate(argv.slice(1));
    case "publish": return await cmdPublish(argv.slice(1));
    default:
      process.stderr.write("usage: sheet-kit <validate|publish|version> [flags]\n");
      return 2;
  }
}

main().then((code) => process.exit(code));
