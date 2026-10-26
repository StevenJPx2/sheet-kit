// publish: render an artifact (manifest.json + data.json) into its spreadsheet.
//
// Two transports:
//   api      (default without --config) render in Node through the Sheets API
//            as the signed-in account (src/render/render.js).
//   webhook  (deprecated; --config) POST data.json inline to the compiled Apps
//            Script web app with the shared secret. SHEET_KIT_TRANSPORT=api
//            switches a --config caller to the API without changing its call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAccessToken } from "../google/auth.js";
import { renderManifest } from "../render/render.js";

/**
 * @typedef {Object} PublishConfig
 * @property {string} url
 * @property {string} secret
 * @property {string} [driveDir]  deprecated and ignored (Drive staging was removed)
 *
 * @typedef {Object} PublishOptions
 * @property {string}  [expectedLatest]  refuse to publish data older than this date (see checkExpectedLatest)
 * @property {boolean} [force]    webhook: skip the incremental render. The API always renders in full.
 * @property {boolean} [profile]  webhook: ask for per-primitive timings
 */

/**
 * Which transport a publish uses: the API unless a webhook config was given,
 * and the API anyway when SHEET_KIT_TRANSPORT=api.
 * @param {boolean} hasConfig
 * @param {string | undefined} env  SHEET_KIT_TRANSPORT
 * @returns {"api" | "webhook"}
 */
export function chooseTransport(hasConfig, env) {
  if (env && env !== "api" && env !== "webhook") throw new Error(`SHEET_KIT_TRANSPORT must be "api" or "webhook", got ${JSON.stringify(env)}`);
  if (env === "api") return "api";
  if (env === "webhook" && !hasConfig) throw new Error("SHEET_KIT_TRANSPORT=webhook needs --config");
  return hasConfig ? "webhook" : "api";
}

/** The newest YYYY-MM-DD string value anywhere in the data ("" if none). @param {import("../types.js").Data} data */
export function dataLatestDate(data) {
  let latest = "";
  for (const rows of Object.values(data.datasets ?? {})) {
    for (const row of rows ?? []) {
      for (const v of Object.values(row ?? {})) {
        const s = String(v ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(s) && s > latest) latest = s;
      }
    }
  }
  return latest;
}

/**
 * --expected-latest used to drive a wait for Drive to sync the staged file.
 * Data now travels as the exact bytes of data.json, so there is nothing to
 * wait for, but the guard against publishing stale data stays: if data.json's
 * newest date is older than expected, refuse (and say so) instead of rendering.
 * @param {import("../types.js").Data} data
 * @param {string | undefined} expected
 * @returns {string} an error message, or ""
 */
export function checkExpectedLatest(data, expected) {
  if (!expected) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expected)) return `--expected-latest must be YYYY-MM-DD, got ${JSON.stringify(expected)}`;
  const latest = dataLatestDate(data);
  return latest >= expected ? "" : `data.json is stale: its newest date is ${latest || "(none)"}, expected ${expected} or later`;
}

/**
 * Render through the Sheets API as the signed-in account.
 * @param {import("../types.js").Manifest} manifest
 * @param {import("../types.js").Data} data
 * @param {(msg: string) => void} log
 * @param {{ token?: string, deps?: import("../google/http.js").HttpDeps }} [o]
 * @returns {Promise<string>} an error message, or ""
 */
export async function publishViaApi(manifest, data, log, { token, deps } = {}) {
  try {
    const result = await renderManifest(manifest, data, { token: token ?? await getAccessToken(), deps });
    for (const w of result.warnings) log(`warning: ${w}`);
    log(`rendered ${result.tabs.map((t) => `${t.sheet}:${t.mode}`).join(", ")} (${result.calls} API calls)`);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * POST a payload to the webhook (token injected) and return its JSON result.
 * @param {PublishConfig} cfg
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
export async function requestWebhook(cfg, payload) {
  const endpoint = new URL(cfg.url);
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret.trim()) throw new Error("invalid webhook config");

  const response = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, token: cfg.secret.trim() }),
  });
  if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);

  const result = /** @type {Record<string, unknown>} */ (await response.json());
  if (!result.ok) throw new Error(String(result.error ?? "webhook rejected request"));
  return result;
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const HTML_RETRIES = 5;
const IMPORT_RETRIES = 3;

/**
 * Deprecated webhook transport: POST data.json inline to the Apps Script web
 * app, retrying its transient failures (an HTML error page instead of JSON; an
 * import error). The caller has already applied checkExpectedLatest.
 * @param {PublishConfig} cfg
 * @param {string} artifactDir
 * @param {PublishOptions} opts
 * @param {(msg: string) => void} log
 * @param {{ wait?: (ms: number) => Promise<unknown> }} [deps]
 * @returns {Promise<string>} an error message, or ""
 */
export async function publishViaWebhook(cfg, artifactDir, opts, log, { wait = sleep } = {}) {
  let endpoint;
  try {
    endpoint = new URL(cfg.url);
  } catch {
    return "invalid webhook config";
  }
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret?.trim()) return "invalid webhook config";

  let raw;
  try {
    raw = readFileSync(join(artifactDir, "data.json"), "utf8");
    JSON.parse(raw);
  } catch (e) {
    return `read data.json: ${String(e)}`;
  }

  const body = JSON.stringify({
    token: cfg.secret.trim(),
    dataInline: raw,
    force: Boolean(opts.force),
    profile: Boolean(opts.profile),
  });

  let htmlRetries = 0;
  let importRetries = 0;
  for (;;) {
    let result, resp, text;
    try {
      resp = await fetch(cfg.url, { method: "POST", headers: { "content-type": "application/json" }, body });
      text = await resp.text();
    } catch (e) {
      return `webhook request: ${String(e)}`;
    }
    try {
      result = JSON.parse(text);
    } catch {
      // Apps Script intermittently serves an HTML error page ("<!DOCTYPE …")
      // instead of JSON: a momentary blip (busy / cold start), so retry soon.
      if (htmlRetries < HTML_RETRIES) {
        htmlRetries++;
        log(`non-JSON webhook response (HTTP ${resp.status}); retry ${htmlRetries}/${HTML_RETRIES} in 2s`);
        await wait(2_000);
        continue;
      }
      return `webhook returned non-JSON after ${htmlRetries} retries (HTTP ${resp.status})`;
    }

    if (result.ok) {
      logRendered(result, log);
      return "";
    }
    if (importRetries < IMPORT_RETRIES) {
      importRetries++;
      log(`import error (${result.error}); retry ${importRetries}/${IMPORT_RETRIES} in 10s`);
      await wait(10_000);
      continue;
    }
    return `webhook rejected import after ${importRetries} retries: ${result.error}`;
  }
}

/**
 * @param {{ tabs?: { sheet: string, mode?: string, ran?: string[], timings?: unknown }[] }} result
 * @param {(msg: string) => void} log
 */
function logRendered(result, log) {
  const modes = (result.tabs ?? []).map((t) => `${t.sheet}:${t.mode ?? "full"}${t.ran?.length ? `[${t.ran.map((n) => n.replace(/^sk_|_$/g, "")).join("+")}]` : ""}`);
  if (modes.length) log(`rendered ${modes.join(", ")}`);
  for (const t of result.tabs ?? []) {
    if (t.timings) log(`timings ${t.sheet} ${JSON.stringify(t.timings)}`);
  }
}

/**
 * @param {string} path
 * @returns {PublishConfig}
 */
export function loadPublishConfig(path) {
  return JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8"));
}

/**
 * The publish command after the artifact has been validated: pick the
 * transport, apply the --expected-latest guard, render. Returns "" or an error.
 * @param {{ manifest: import("../types.js").Manifest, data: import("../types.js").Data, artifactDir: string }} artifact
 * @param {{ config?: string, expectedLatest?: string, full?: boolean, profile?: boolean }} flags
 * @param {(msg: string) => void} log
 * @param {{ env?: string, token?: string, http?: import("../google/http.js").HttpDeps, wait?: (ms: number) => Promise<unknown>, readConfig?: (path: string) => PublishConfig }} [deps]
 */
export async function publish(artifact, flags, log, deps = {}) {
  let transport;
  try {
    transport = chooseTransport(Boolean(flags.config), deps.env ?? process.env.SHEET_KIT_TRANSPORT);
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
  const stale = checkExpectedLatest(artifact.data, flags.expectedLatest);
  if (stale) return stale;

  if (transport === "api") {
    if (flags.config) log("note: SHEET_KIT_TRANSPORT=api: rendering through the Sheets API; the webhook config is ignored");
    if (flags.profile) log("note: --profile applies to the webhook only; ignored");
    return publishViaApi(artifact.manifest, artifact.data, log, { token: deps.token, deps: deps.http });
  }

  let cfg;
  try {
    cfg = (deps.readConfig ?? loadPublishConfig)(/** @type {string} */ (flags.config));
  } catch (e) {
    return `read webhook config: ${String(e)}`;
  }
  if (cfg.driveDir) log("note: driveDir is ignored; publish sends data inline (Drive staging was removed)");
  log("note: the webhook transport is deprecated; publish without --config (or set SHEET_KIT_TRANSPORT=api) to render through the Sheets API");
  return publishViaWebhook(cfg, artifact.artifactDir, { force: flags.full, profile: flags.profile }, log, { wait: deps.wait });
}
