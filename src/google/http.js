// One authenticated JSON call to a Google REST API, with the error body turned
// into an actionable message (disabled APIs, the Apps Script user setting).

const USER_SETTINGS_URL = "https://script.google.com/home/usersettings";

/**
 * @typedef {{ reason?: string, metadata?: Record<string, string> }} ErrorInfo
 * @typedef {{ error?: { code?: number, message?: string, status?: string, details?: ErrorInfo[] } }} ErrorBody
 */

/**
 * @param {string} token
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<any>}
 */
export async function googleJson(token, method, url, body, fetchImpl = fetch) {
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  /** @type {any} */
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!res.ok) throw new Error(describeError(res.status, parsed, text));
  return parsed;
}

/**
 * Turn a Google error response into one line a user can act on.
 * @param {number} status
 * @param {ErrorBody} body
 * @param {string} [raw]
 */
export function describeError(status, body, raw = "") {
  const message = body.error?.message ?? (raw.slice(0, 200) || "no error body");
  const info = (body.error?.details ?? []).find((d) => d.reason);

  if (/User has not enabled the Apps Script API/i.test(message)) {
    return `the Apps Script API is turned off for your account. Turn it on at ${USER_SETTINGS_URL}, wait a minute, then retry.`;
  }
  if (info?.reason === "SERVICE_DISABLED" || /has not been used in project .* or it is disabled/i.test(message)) {
    const service = info?.metadata?.service ?? "the API";
    const where = info?.metadata?.consumer ? ` in ${info.metadata.consumer}` : "";
    const link = info?.metadata?.activationUrl ? ` Enable it: ${info.metadata.activationUrl}` : "";
    return `${service} is not enabled${where} (the OAuth client's Cloud project).${link} Then retry.`;
  }
  if (status === 401) return `HTTP 401: ${message}. Run \`sheet-kit auth login\`.`;
  return `HTTP ${status}: ${message}`;
}
