// Send the artifact's data.json inline to the generic Apps Script webhook and
// let it render. Domain-agnostic: POST the bytes with the shared secret.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {Object} PublishConfig
 * @property {string} url
 * @property {string} secret
 * @property {string} [driveDir]  deprecated and ignored (Drive staging was removed)
 *
 * @typedef {Object} PublishOptions
 * @property {string}  [expectedLatest]  accepted for old callers; a no-op (see publish)
 * @property {boolean} [force]    skip the webhook's incremental (values-only) render
 * @property {boolean} [profile]  ask the webhook for per-primitive timings
 */

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
 * POST data.json inline to the webhook, retrying Apps Script's transient
 * failures (an HTML error page instead of JSON; an import error). Returns an
 * error message or "".
 *
 * --expected-latest is a no-op: it only fed the Drive-sync staleness handshake,
 * which existed because the webhook might read an older staged file. Inline
 * data is exactly the bytes in data.json, so there is nothing to wait for.
 * @param {PublishConfig} cfg
 * @param {string} artifactDir
 * @param {string | PublishOptions} options  a string is the legacy expectedLatest
 * @param {(msg: string) => void} log
 * @param {{ wait?: (ms: number) => Promise<unknown> }} [deps]
 * @returns {Promise<string>}
 */
export async function publish(cfg, artifactDir, options, log, { wait = sleep } = {}) {
  const opts = typeof options === "string" ? { expectedLatest: options } : (options ?? {});
  let endpoint;
  try {
    endpoint = new URL(cfg.url);
  } catch {
    return "invalid webhook config";
  }
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret?.trim()) return "invalid webhook config";
  if (cfg.driveDir) log("note: driveDir is ignored; publish sends data inline (Drive staging was removed)");
  if (opts.expectedLatest) log("note: --expected-latest is no longer needed; inline data has no Drive sync to wait for");

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
