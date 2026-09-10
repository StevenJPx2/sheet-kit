// Stage the artifact to the mounted Google Drive folder and trigger the generic
// Apps Script webhook to render it. Domain-agnostic: move files + POST a token.
// Ported from the Go internal/publish. node:fs + fetch → statically compilable.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PublishConfig {
  url: string;
  secret: string;
  driveDir: string;
}

interface WebhookResult {
  ok?: boolean;
  stale?: boolean;
  latest?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Publish copies manifest.json + data.json into the mounted Drive folder, POSTs
 * the webhook, and runs the Drive-sync staleness retry loop until the importer
 * confirms it rendered the just-written data. Returns an error message or "".
 */
export async function publish(
  cfg: PublishConfig,
  artifactDir: string,
  expectedLatest: string,
  log: (msg: string) => void,
): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = new URL(cfg.url);
  } catch {
    return "invalid webhook config";
  }
  if (endpoint.protocol !== "https:" || !endpoint.host || !cfg.secret.trim()) return "invalid webhook config";
  if (!cfg.driveDir) return "driveDir is required";

  for (const name of ["manifest.json", "data.json"]) {
    const dst = join(cfg.driveDir, name);
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(artifactDir, name), dst);
    } catch (e) {
      return `stage ${name} to Drive: ${String(e)}`;
    }
  }

  const body = JSON.stringify({
    token: cfg.secret.trim(),
    manifest: "manifest.json",
    data: "data.json",
    expectedLatest,
  });

  const deadline = Date.now() + 5 * 60_000;
  let transientRetries = 0;
  for (;;) {
    let result: WebhookResult;
    try {
      const resp = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!resp.ok) return `webhook HTTP ${resp.status}`;
      result = (await resp.json()) as WebhookResult;
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

export function loadPublishConfig(path: string): PublishConfig {
  return JSON.parse(readFileSync(path, "utf8")) as PublishConfig;
}
