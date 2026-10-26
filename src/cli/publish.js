// Stage the artifact to the mounted Google Drive folder and trigger the generic
// Apps Script webhook to render it. Domain-agnostic: move files + POST a token.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Expand a leading ~/ to the user's home dir (path.join won't, and driveDir is
// authored with ~ in merchant configs).
const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * @typedef {Object} PublishConfig
 * @property {string} url
 * @property {string} secret
 * @property {string} driveDir
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stage a file into the mounted Drive folder, retrying the transient Google
// Drive File Stream FUSE error ("Unknown system error -11") that fires while it
// syncs. Exponential backoff (~30s total, 8 attempts); copy/wait are injectable
// for tests.
export async function stageWithRetry(src, dest, copy = copyFileSync, wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      copy(src, dest);
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await wait(Math.min(500 * 2 ** attempt, 8000));
    }
  }
}

/**
 * Copy one uniquely named data file into the mounted Drive folder, POST the
 * filename, and run the Drive-sync staleness retry loop until the importer
 * confirms it rendered the just-written data. Returns an error message or "".
 * @param {PublishConfig} cfg
 * @param {string} artifactDir
 * @param {string | {expectedLatest?: string, force?: boolean, profile?: boolean}} options
 *   expectedLatest (max data date) drives the staleness handshake; force skips
 *   the webhook's incremental (values-only) render and forces a full re-style.
 * @param {(msg: string) => void} log
 * @returns {Promise<string>}
 */
export async function publish(cfg, artifactDir, options, log) {
  const opts = typeof options === "string" ? { expectedLatest: options } : (options ?? {});
  const expectedLatest = opts.expectedLatest ?? "";
  let endpoint;
  try {
    endpoint = new URL(cfg.url);
  } catch {
    return "invalid webhook config";
  }
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret.trim()) return "invalid webhook config";

  let datasetKey, expectedHash, raw;
  try {
    raw = readFileSync(join(artifactDir, "data.json"), "utf8");
    const data = JSON.parse(raw);
    const keys = Object.keys(data.datasets ?? {});
    if (keys.length !== 1) return `publish requires exactly one dataset (found ${keys.length})`;
    datasetKey = keys[0].replace(/[^A-Za-z0-9._-]/g, "_");
    // Content hash of the exact bytes: with Drive staging the webhook renders only
    // once the file it reads hashes to this (Drive sync lag); with inline data it
    // is informational.
    expectedHash = createHash("sha256").update(raw).digest("hex");
  } catch (e) {
    return `read data.json: ${String(e)}`;
  }

  // Transport: the bytes go INLINE in the POST (≤ tens of KB; Apps Script accepts
  // MBs) — no cloud-sync wait. When driveDir is configured we ALSO stage the file
  // so a webhook that predates dataInline still renders via the Drive path.
  const dataName = `data.${datasetKey}.json`;
  if (cfg.driveDir) {
    const destination = join(expandHome(cfg.driveDir), dataName);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      await stageWithRetry(join(artifactDir, "data.json"), destination);
    } catch (error) {
      return `stage data.json to Drive: ${String(error)}`;
    }
  }

  const body = JSON.stringify({
    token: cfg.secret.trim(),
    data: dataName,
    dataInline: raw,
    expectedLatest,
    expectedHash,
    force: Boolean(opts.force),
    profile: Boolean(opts.profile),
  });


  const deadline = Date.now() + 5 * 60_000;
  let transientRetries = 0;
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
      // instead of JSON; treat it as transient and retry.
      // Apps Script's HTML error page is a momentary blip (busy / cold start),
      // not a state that needs 10s to clear: back off briefly, try more often.
      if (transientRetries < 5) {
        transientRetries++;
        log(`non-JSON webhook response (HTTP ${resp.status}); retry ${transientRetries}/5 in 2s`);
        await sleep(2_000);
        continue;
      }
      return `webhook returned non-JSON after ${transientRetries} retries (HTTP ${resp.status})`;
    }

    if (result.ok) {
      const modes = (result.tabs ?? []).map((t) => `${t.sheet}:${t.mode ?? "full"}${t.ran?.length ? `[${t.ran.map((n) => n.replace(/^sk_|_$/g, "")).join("+")}]` : ""}`);
      if (modes.length) log(`rendered ${modes.join(", ")}`);
      for (const t of result.tabs ?? []) {
        if (t.timings) log(`timings ${t.sheet} ${JSON.stringify(t.timings)}`);
      }
      return "";
    }
    if (result.stale) {
      if (Date.now() > deadline) return `sheet still stale after retries (Drive not synced; latest=${result.latest})`;
      log(`artifact not synced to Drive yet (latest=${result.latest}); retrying in 15s`);
      await sleep(15_000);
      continue;
    }
    if (transientRetries < 3) {
      transientRetries++;
      log(`import error (${result.error}); retry ${transientRetries}/3 in 10s`);
      await sleep(10_000);
      continue;
    }
    return `webhook rejected import after ${transientRetries} retries: ${result.error}`;
  }
}

/**
 * @param {string} path
 * @returns {PublishConfig}
 */
export function loadPublishConfig(path) {
  return JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8"));
}
