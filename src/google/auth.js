// sheet-kit's own Google sign-in, mirroring doc-kit: an installed-app OAuth
// client (client.json from Cloud Console), loopback redirect with PKCE, and a
// refresh token stored under the config dir. SHEET_KIT_ACCESS_TOKEN
// short-circuits all of it for one-off use. Without a client of its own,
// sheet-kit reuses doc-kit's client.json, so one Desktop client serves both.
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { googleJson } from "./http.js";

// deploy: script.projects (updateContent, versions.create) + script.deployments.
// inspect: spreadsheets.readonly. openid + email: the account's address for
// `auth status` and --expect-domain.
export const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "openid",
  "email",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const EXPIRY_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * @typedef {{ client_id: string, client_secret: string }} Client
 * @typedef {{ access_token: string, refresh_token: string, expiry: number, scope: string, email: string }} StoredToken
 */

export function configDir() {
  return process.env.SHEET_KIT_CONFIG_DIR || join(homedir(), ".config", "sheet-kit");
}
function docKitConfigDir() {
  return process.env.DOC_KIT_CONFIG_DIR || join(homedir(), ".config", "doc-kit");
}
const ownClientPath = () => join(configDir(), "client.json");
const tokenPath = () => join(configDir(), "token.json");

/** sheet-kit's client.json if present, else doc-kit's, else sheet-kit's (missing). */
export function clientPath() {
  const own = ownClientPath();
  if (existsSync(own)) return own;
  const docKit = join(docKitConfigDir(), "client.json");
  return existsSync(docKit) ? docKit : own;
}

/**
 * Read an OAuth client file as downloaded from Cloud Console ({ installed: {...} }).
 * @param {string} [path]
 * @returns {Client}
 */
export function loadClient(path = clientPath()) {
  if (!existsSync(path)) {
    throw new Error(`no OAuth client at ${path}. Run \`sheet-kit auth login --client <client_secret.json>\` (see README: "Google sign-in").`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error(`${path} has no client_id/client_secret`);
  return { client_id: c.client_id, client_secret: c.client_secret };
}

/** @returns {StoredToken | null} */
export function loadToken() {
  if (!existsSync(tokenPath())) return null;
  return JSON.parse(readFileSync(tokenPath(), "utf8"));
}

/** True when a token is available without an interactive sign-in. */
export function isSignedIn() {
  return Boolean(process.env.SHEET_KIT_ACCESS_TOKEN) || existsSync(tokenPath());
}

/** @param {StoredToken} t */
function saveToken(t) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(), JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
}

/**
 * @param {Record<string, string>} params
 * @param {typeof fetch} fetchImpl
 */
async function tokenRequest(params, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${body.error_description || body.error || "unknown error"}`);
  return body;
}

/**
 * A valid access token: from SHEET_KIT_ACCESS_TOKEN, the stored token, or a refresh.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export async function getAccessToken({ fetchImpl = fetch, now = Date.now } = {}) {
  const env = process.env.SHEET_KIT_ACCESS_TOKEN;
  if (env) return env;

  const t = loadToken();
  if (!t) throw new Error("not signed in. Run `sheet-kit auth login`.");
  if (t.expiry - EXPIRY_MARGIN_MS > now()) return t.access_token;

  const client = loadClient();
  const r = await tokenRequest(
    { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id, client_secret: client.client_secret },
    fetchImpl,
  );
  const next = { ...t, access_token: r.access_token, expiry: now() + r.expires_in * 1000, scope: r.scope ?? t.scope };
  saveToken(next);
  return next.access_token;
}

/**
 * The signed-in account's email address.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function whoami(token, fetchImpl = fetch) {
  const info = await googleJson(token, "GET", USERINFO_URL, undefined, fetchImpl);
  if (!info.email) throw new Error("userinfo returned no email; sign in again with `sheet-kit auth login`");
  return String(info.email);
}

/** @param {string} email @param {string} [domain] */
export function checkDomain(email, domain) {
  if (!domain) return "";
  const d = domain.replace(/^@/, "").toLowerCase();
  return email.toLowerCase().endsWith(`@${d}`) ? "" : `signed in as ${email}, expected an @${d} account`;
}

/**
 * Wait for Google's redirect to the loopback server; resolves the auth code.
 * @param {import("node:http").Server} server
 * @param {string} redirectUri
 * @param {string} state
 * @returns {Promise<string>}
 */
function awaitRedirect(server, redirectUri, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in timed out after 5 minutes")), LOGIN_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const q = new URL(req.url ?? "/", redirectUri).searchParams;
      if (!q.has("code") && !q.has("error")) { res.writeHead(404).end(); return; }
      const ok = q.get("state") === state && q.has("code");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ok ? "sheet-kit is signed in. You can close this tab." : "sheet-kit sign-in failed. Check the terminal.");
      clearTimeout(timer);
      if (q.get("state") !== state) reject(new Error("sign-in state mismatch"));
      else if (q.has("error")) reject(new Error(`Google sign-in error: ${q.get("error")}`));
      else resolve(/** @type {string} */ (q.get("code")));
    });
  });
}

/**
 * Interactive sign-in. Opens the consent page, waits for the loopback redirect,
 * and stores the refresh token. Refuses to store a token for the wrong domain.
 * @param {{
 *   client?: string, account?: string, expectDomain?: string,
 *   openUrl?: (url: string) => void, log?: (msg: string) => void,
 * }} opts
 */
export async function login(opts) {
  const log = opts.log ?? (() => {});
  if (opts.client) {
    loadClient(opts.client);
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    copyFileSync(opts.client, ownClientPath());
  }
  const path = clientPath();
  const client = loadClient(path);
  if (path !== ownClientPath()) log(`Using doc-kit's OAuth client (${path}).`);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
    ...(opts.account ? { login_hint: opts.account } : {}),
    ...(opts.expectDomain ? { hd: opts.expectDomain.replace(/^@/, "") } : {}),
  }).toString();

  log(`Opening Google sign-in. If no browser opens, visit:\n${url}`);
  opts.openUrl?.(url.toString());

  /** @type {string} */
  let code;
  try {
    code = await awaitRedirect(server, redirectUri, state);
  } finally {
    server.close();
  }

  const r = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      client_secret: client.client_secret,
    },
    fetch,
  );
  if (!r.refresh_token) throw new Error("Google returned no refresh token; run `sheet-kit auth logout` and sign in again");

  const email = await whoami(r.access_token);
  const domainErr = checkDomain(email, opts.expectDomain);
  if (domainErr) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(r.refresh_token)}`, { method: "POST" }).catch(() => {});
    throw new Error(`${domainErr}; token discarded`);
  }

  saveToken({
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expiry: Date.now() + r.expires_in * 1000,
    scope: r.scope ?? SCOPES.join(" "),
    email,
  });
  return email;
}

/** Revoke and delete the stored token. Keeps client.json. */
export async function logout() {
  const t = loadToken();
  if (!t) return false;
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(t.refresh_token)}`, { method: "POST" }).catch(() => {});
  rmSync(tokenPath(), { force: true });
  return true;
}
