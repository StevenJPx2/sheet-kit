// Stage the artifact to the mounted Google Drive folder and trigger the generic
// Apps Script webhook to render it. Domain-agnostic: move files + POST a token.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/**
 * Copy manifest.json + data.json into the mounted Drive folder under
 * dataset-specific names, POST the
 * webhook, and run the Drive-sync staleness retry loop until the importer
 * confirms it rendered the just-written data. Returns an error message or "".
 * @param {PublishConfig} cfg
 * @param {string} artifactDir
 * @param {string} expectedLatest
 * @param {(msg: string) => void} log
 * @returns {Promise<string>}
 */
export async function publish(cfg, artifactDir, expectedLatest, log) {
  let endpoint;
  try {
    endpoint = new URL(cfg.url);
  } catch {
    return "invalid webhook config";
  }
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret.trim()) return "invalid webhook config";
  if (!cfg.driveDir) return "driveDir is required";

  let datasetKey;
  try {
    const data = JSON.parse(readFileSync(join(artifactDir, "data.json"), "utf8"));
    const keys = Object.keys(data.datasets ?? {});
    if (keys.length !== 1) return `publish requires exactly one dataset (found ${keys.length})`;
    datasetKey = keys[0].replace(/[^A-Za-z0-9._-]/g, "_");
  } catch (e) {
    return `read data.json: ${String(e)}`;
  }

  const manifestName = `manifest.${datasetKey}.json`;
  const dataName = `data.${datasetKey}.json`;
  for (const [source, name] of [["manifest.json", manifestName], ["data.json", dataName]]) {
    const dst = join(cfg.driveDir, name);
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(artifactDir, source), dst);
    } catch (e) {
      return `stage ${source} to Drive: ${String(e)}`;
    }
  }

  const body = JSON.stringify({
    token: cfg.secret.trim(),
    manifest: manifestName,
    data: dataName,
    expectedLatest,
  });

  const deadline = Date.now() + 5 * 60_000;
  let transientRetries = 0;
  for (;;) {
    let result;
    try {
      const resp = await fetch(cfg.url, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (!resp.ok) return `webhook HTTP ${resp.status}`;
      result = await resp.json();
    } catch (e) {
      return `webhook request: ${String(e)}`;
    }

    if (result.ok) return "";
    if (result.stale) {
      if (Date.now() > deadline) return `sheet still stale after retries (latest=${result.latest}, want ${expectedLatest})`;
      log(`artifact not synced yet (latest=${result.latest}, want ${expectedLatest}); retrying in 15s`);
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
