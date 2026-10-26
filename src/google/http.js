// One authenticated JSON call to a Google REST API: bounded retries for the
// quota/transient statuses Google asks clients to back off on (429, 5xx), and
// the error body turned into one actionable line.

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 32_000;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {{ error?: { code?: number, message?: string, status?: string } }} ErrorBody
 * @typedef {{ fetchImpl?: typeof fetch, wait?: (ms: number) => Promise<unknown> }} HttpDeps
 */

/**
 * @param {string} token
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @param {HttpDeps} [deps]
 * @returns {Promise<any>}
 */
export async function googleJson(token, method, url, body, { fetchImpl = fetch, wait = sleep } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);

  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, { method, headers, body: payload });
    const text = await res.text();
    /** @type {any} */
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (res.ok) return parsed;
    if (!RETRY_STATUSES.has(res.status) || attempt >= MAX_ATTEMPTS) throw new Error(describeError(res.status, parsed, text));
    // Truncated exponential backoff with jitter (Sheets API usage-limits guidance).
    await wait(Math.min(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000), MAX_BACKOFF_MS));
  }
}

/**
 * Turn a Google error response into one line a user can act on.
 * @param {number} status
 * @param {ErrorBody} body
 * @param {string} [raw]
 */
export function describeError(status, body, raw = "") {
  const message = body.error?.message ?? (raw.slice(0, 200) || "no error body");
  if (status === 401) return `HTTP 401: ${message}. Run \`sheet-kit auth login\`.`;
  if (status === 403) return `HTTP 403: ${message}. Check that the signed-in account (\`sheet-kit auth status\`) can edit this spreadsheet.`;
  if (status === 404) return `HTTP 404: ${message}. Check the spreadsheet id.`;
  return `HTTP ${status}: ${message}`;
}
