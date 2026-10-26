// The four Sheets API v4 calls sheet-kit makes: spreadsheets.get (field mask),
// spreadsheets.batchUpdate, values.batchUpdate and values.batchGet. Writes are
// split so no request body exceeds MAX_BODY_BYTES (Google recommends ≤ 2 MB).
import { googleJson } from "./http.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const MAX_BODY_BYTES = 1_500_000;

/**
 * @typedef {import("./http.js").HttpDeps} HttpDeps
 * @typedef {{ range: string, majorDimension: "ROWS", values: unknown[][] }} ValueRange
 */

/**
 * A spreadsheet handle: the id, a token, and the injectable transport.
 * @param {string} spreadsheetId
 * @param {string} token
 * @param {HttpDeps} [deps]
 */
export function sheetsClient(spreadsheetId, token, deps = {}) {
  const base = `${API}/${encodeURIComponent(spreadsheetId)}`;
  let calls = 0;
  /** @param {string} method @param {string} url @param {unknown} [body] */
  const call = (method, url, body) => { calls++; return googleJson(token, method, url, body, deps); };
  return {
    get calls() { return calls; },
    /** @param {string} fields @param {string[]} [ranges] */
    get(fields, ranges = []) {
      const q = new URLSearchParams({ fields });
      for (const r of ranges) q.append("ranges", r);
      return call("GET", `${base}?${q}`);
    },
    /** @param {object[]} requests */
    async batchUpdate(requests) {
      for (const chunk of chunkBySize(requests)) await call("POST", `${base}:batchUpdate`, { requests: chunk });
    },
    /** @param {ValueRange[]} data */
    async writeValues(data) {
      for (const chunk of chunkBySize(data.flatMap(splitValueRange))) {
        await call("POST", `${base}/values:batchUpdate`, { valueInputOption: "USER_ENTERED", data: chunk });
      }
    },
    /** @param {string[]} ranges @param {"FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA"} render */
    async readValues(ranges, render) {
      if (!ranges.length) return [];
      const q = new URLSearchParams({ valueRenderOption: render, majorDimension: "ROWS" });
      for (const r of ranges) q.append("ranges", r);
      const resp = await call("GET", `${base}/values:batchGet?${q}`);
      return (resp.valueRanges ?? []).map((/** @type {any} */ v) => v.values ?? []);
    },
  };
}

/** @typedef {ReturnType<typeof sheetsClient>} SheetsClient */

/** 'Tab name' quoted for A1 notation. @param {string} title */
export function quoteSheet(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Split items into consecutive groups whose JSON stays under the byte budget.
 * A single oversized item still travels alone.
 * @template T
 * @param {T[]} items
 * @param {number} [limit]
 * @returns {T[][]}
 */
export function chunkBySize(items, limit = MAX_BODY_BYTES) {
  /** @type {T[][]} */
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const n = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (current.length && size + n > limit) { chunks.push(current); current = []; size = 0; }
    current.push(item);
    size += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Split one tab's values into row blocks that each fit the byte budget, so a
 * very large tab can span several values.batchUpdate calls.
 * @param {ValueRange} vr  range must be "'Tab'!A<row>"
 * @returns {ValueRange[]}
 */
function splitValueRange(vr) {
  const match = /^(.*)!A(\d+)$/.exec(vr.range);
  if (!match || Buffer.byteLength(JSON.stringify(vr)) <= MAX_BODY_BYTES) return [vr];
  const [, sheet, startRow] = match;
  return chunkBySize(vr.values).reduce((/** @type {{ out: ValueRange[], row: number }} */ acc, rows) => {
    acc.out.push({ range: `${sheet}!A${acc.row}`, majorDimension: "ROWS", values: rows });
    acc.row += rows.length;
    return acc;
  }, { out: [], row: Number(startRow) }).out;
}
