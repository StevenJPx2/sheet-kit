// sheet-kit's Google sign-in, copied from doc-kit's design. It goes through the
// login service Google runs for its Gemini CLI Workspace extension (the same one
// the Google Workspace MCP uses), so no OAuth client of our own is needed: the
// service holds the client secret, swaps the browser's code for tokens, and
// renews access tokens.
//
//   login:   browser → Google consent (extension's client id, redirect to the
//            service) → service exchanges the code → redirects to our loopback
//            port with the tokens. On a machine without a browser, `--paste`
//            takes the credentials JSON the service shows instead.
//   refresh: POST {service}/refreshToken { refresh_token }.
//
// Credentials, first match wins: SHEET_KIT_ACCESS_TOKEN (one-off), the token
// file in the config dir, SHEET_KIT_REFRESH_TOKEN (a cron host's secret store,
// no files needed).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Drive scope covers Sheets reads and writes (and whoami via Drive `about`). */
export const SCOPES = ["https://www.googleapis.com/auth/drive"];
export const CLIENT_ID = process.env.SHEET_KIT_CLIENT_ID || "338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com";
export const LOGIN_SERVICE = (process.env.SHEET_KIT_LOGIN_SERVICE || "https://google-workspace-extension.geminicli.com").replace(/\/$/, "");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
const EXPIRY_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * @typedef {{ access_token: string, refresh_token: string, expiry: number, scope: string, email: string }} StoredToken
 * @typedef {{ access_token: string, refresh_token: string, expiry_date: number, scope: string }} Tokens
 */

export function configDir() {
  return process.env.SHEET_KIT_CONFIG_DIR || join(homedir(), ".config", "sheet-kit");
}
const tokenPath = () => join(configDir(), "token.json");

/** @returns {StoredToken | null} */
export function loadToken() {
  if (!existsSync(tokenPath())) return null;
  return JSON.parse(readFileSync(tokenPath(), "utf8"));
}

/** @param {StoredToken} t */
function saveToken(t) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(), JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
}

/** Where the active sign-in comes from, or "" when there is none. */
export function credentialSource() {
  if (process.env.SHEET_KIT_ACCESS_TOKEN) return "SHEET_KIT_ACCESS_TOKEN";
  if (loadToken()) return `config: ${configDir()}`;
  if (process.env.SHEET_KIT_REFRESH_TOKEN) return "SHEET_KIT_REFRESH_TOKEN";
  return "";
}

/**
 * Renew an access token through the login service.
 * @param {string} refreshToken
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ access_token: string, expiry_date: number, scope?: string }>}
 */
export async function refreshAccessToken(refreshToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${LOGIN_SERVICE}/refreshToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await res.text();
  /** @type {any} */
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant") {
      throw new Error("the saved Google sign-in was revoked or has expired. Run `sheet-kit auth login` again (and update SHEET_KIT_REFRESH_TOKEN on hosts that use it).");
    }
    throw new Error(`token refresh failed (HTTP ${res.status}): ${body.error_description || body.error || text.slice(0, 200) || "no details"}`);
  }
  return body;
}

/**
 * A valid access token: SHEET_KIT_ACCESS_TOKEN, the stored token (renewed when
 * it's about to expire), or SHEET_KIT_REFRESH_TOKEN.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export async function getAccessToken({ fetchImpl = fetch, now = Date.now } = {}) {
  const env = process.env.SHEET_KIT_ACCESS_TOKEN;
  if (env) return env;

  const t = loadToken();
  if (!t) {
    const refresh = process.env.SHEET_KIT_REFRESH_TOKEN;
    if (refresh) return (await refreshAccessToken(refresh, fetchImpl)).access_token;
    throw new Error("not signed in. Run `sheet-kit auth login` (or set SHEET_KIT_REFRESH_TOKEN).");
  }
  if (t.expiry - EXPIRY_MARGIN_MS > now()) return t.access_token;

  const r = await refreshAccessToken(t.refresh_token, fetchImpl);
  const next = { ...t, access_token: r.access_token, expiry: r.expiry_date, scope: r.scope ?? t.scope };
  saveToken(next);
  return next.access_token;
}

/**
 * The signed-in account's email address (Drive `about`, covered by the scope).
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function whoami(token, fetchImpl = fetch) {
  const res = await fetchImpl(ABOUT_URL, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`whoami: HTTP ${res.status}: ${text.slice(0, 200)}`);
  const email = JSON.parse(text).user?.emailAddress;
  if (!email) throw new Error("whoami: Google returned no account email");
  return String(email);
}

/** @param {string} email @param {string} [domain] */
export function checkDomain(email, domain) {
  if (!domain) return "";
  const d = domain.replace(/^@/, "").toLowerCase();
  return email.toLowerCase().endsWith(`@${d}`) ? "" : `signed in as ${email}, expected an @${d} account`;
}

/**
 * The consent URL. `uri` is where the service sends the tokens; without it the
 * service shows them on a page for pasting (`manual`).
 * @param {{ uri?: string, csrf: string, account?: string, expectDomain?: string }} o
 */
export function authUrl({ uri, csrf, account, expectDomain }) {
  const state = Buffer.from(JSON.stringify({ uri, manual: !uri, csrf })).toString("base64");
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: LOGIN_SERVICE,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    ...(account ? { login_hint: account } : {}),
    ...(expectDomain ? { hd: expectDomain.replace(/^@/, "") } : {}),
  }).toString();
  return url.toString();
}

/**
 * Tokens from the service's loopback redirect, after checking the CSRF value.
 * @param {URLSearchParams} q
 * @param {string} csrf
 * @returns {Tokens}
 */
export function tokensFromRedirect(q, csrf) {
  if (q.get("state") !== csrf) throw new Error("sign-in state mismatch");
  if (q.get("error")) throw new Error(`Google sign-in error: ${q.get("error")}`);
  const access_token = q.get("access_token");
  const refresh_token = q.get("refresh_token");
  const expiry_date = Number(q.get("expiry_date"));
  if (!access_token || !expiry_date) throw new Error("sign-in failed: the login service sent no tokens");
  if (!refresh_token) throw new Error("Google returned no refresh token; run `sheet-kit auth logout` and sign in again");
  return { access_token, refresh_token, expiry_date, scope: q.get("scope") ?? SCOPES.join(" ") };
}

/**
 * Tokens from the credentials JSON the service shows in manual mode.
 * @param {string} text
 * @returns {Tokens}
 */
export function tokensFromPaste(text) {
  /** @type {any} */
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("that isn't the credentials JSON from the sign-in page"); }
  if (!j.access_token || !j.refresh_token || !j.expiry_date) throw new Error("the pasted JSON has no access_token, refresh_token or expiry_date");
  return { access_token: j.access_token, refresh_token: j.refresh_token, expiry_date: Number(j.expiry_date), scope: j.scope ?? SCOPES.join(" ") };
}

/** @param {string} token @param {typeof fetch} fetchImpl */
async function revoke(token, fetchImpl) {
  await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

/**
 * Store the tokens unless the account is outside the expected domain, in which
 * case the grant is revoked.
 * @param {Tokens} tokens
 * @param {string | undefined} expectDomain
 * @param {typeof fetch} fetchImpl
 */
async function storeTokens(tokens, expectDomain, fetchImpl) {
  const email = await whoami(tokens.access_token, fetchImpl);
  const domainErr = checkDomain(email, expectDomain);
  if (domainErr) {
    await revoke(tokens.refresh_token, fetchImpl);
    throw new Error(`${domainErr}; token discarded`);
  }
  saveToken({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry: tokens.expiry_date, scope: tokens.scope, email });
  return email;
}

/**
 * Wait for the login service's redirect to our loopback port.
 * @param {import("node:http").Server} server
 * @param {string} uri
 * @param {string} csrf
 * @returns {Promise<Tokens>}
 */
function awaitTokens(server, uri, csrf) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in timed out after 5 minutes")), LOGIN_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", uri);
      if (u.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
      clearTimeout(timer);
      try {
        const t = tokensFromRedirect(u.searchParams, csrf);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("sheet-kit is signed in. You can close this tab.");
        resolve(t);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("sheet-kit sign-in failed. Check the terminal.");
        reject(e);
      }
    });
  });
}

/**
 * Interactive sign-in through the browser and a loopback port.
 * @param {{ account?: string, expectDomain?: string, openUrl?: (url: string) => void, log?: (msg: string) => void, fetchImpl?: typeof fetch }} opts
 */
export async function login(opts) {
  const log = opts.log ?? (() => {});
  const csrf = randomBytes(32).toString("hex");

  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const uri = `http://127.0.0.1:${port}/oauth2callback`;
  const url = authUrl({ uri, csrf, account: opts.account, expectDomain: opts.expectDomain });

  log(`Opening Google sign-in. If no browser opens, visit:\n${url}`);
  opts.openUrl?.(url);

  let tokens;
  try {
    tokens = await awaitTokens(server, uri, csrf);
  } finally {
    server.close();
  }
  return storeTokens(tokens, opts.expectDomain, opts.fetchImpl ?? fetch);
}

/**
 * Sign-in for machines without a browser: print the URL, then read the
 * credentials JSON the sign-in page shows.
 * @param {{ account?: string, expectDomain?: string, readPaste: () => Promise<string>, log?: (msg: string) => void, fetchImpl?: typeof fetch }} opts
 */
export async function loginWithPaste(opts) {
  const csrf = randomBytes(32).toString("hex");
  const url = authUrl({ csrf, account: opts.account, expectDomain: opts.expectDomain });
  opts.log?.(`Open this URL in any browser, sign in, then paste the "Credentials JSON" it shows and press Ctrl-D:\n${url}`);
  return storeTokens(tokensFromPaste(await opts.readPaste()), opts.expectDomain, opts.fetchImpl ?? fetch);
}

/** Revoke and delete the stored token. @param {typeof fetch} [fetchImpl] */
export async function logout(fetchImpl = fetch) {
  const t = loadToken();
  if (!t) return false;
  await revoke(t.refresh_token, fetchImpl);
  rmSync(tokenPath(), { force: true });
  return true;
}
