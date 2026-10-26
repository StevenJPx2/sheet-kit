// Publish a validated manifest + data through the Sheets API.
import { getAccessToken } from "../google/auth.js";
import { renderManifest } from "../render/render.js";

/** The newest exact YYYY-MM-DD value in the datasets, or "". @param {import("../types.js").Data} data */
export function dataLatestDate(data) {
  let latest = "";
  for (const rows of Object.values(data.datasets)) {
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value > latest) latest = value;
      }
    }
  }
  return latest;
}

/**
 * Local stale-data guard. This checks the maximum date across all datasets,
 * not their individual freshness or content.
 * @param {import("../types.js").Data} data
 * @param {string | undefined} expected
 */
export function checkExpectedLatest(data, expected) {
  if (!expected) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expected)) return `--expected-latest must be YYYY-MM-DD, got ${JSON.stringify(expected)}`;
  const latest = dataLatestDate(data);
  return latest >= expected ? "" : `data.json is stale: its newest date is ${latest || "(none)"}, expected ${expected} or later`;
}

/**
 * Validate freshness before obtaining credentials or making any writes.
 * @param {import("../types.js").Manifest} manifest
 * @param {import("../types.js").Data} data
 * @param {{ expectedLatest?: string, token?: string, http?: import("../google/http.js").HttpDeps }} [options]
 */
export async function publish(manifest, data, { expectedLatest, token, http } = {}) {
  const stale = checkExpectedLatest(data, expectedLatest);
  if (stale) throw new Error(stale);
  return renderManifest(manifest, data, { token: token ?? await getAccessToken({ fetchImpl: http?.fetchImpl }), deps: http });
}
