import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  authUrl, checkDomain, CLIENT_ID, credentialSource, getAccessToken, LOGIN_SERVICE,
  login, loginWithPaste, logout, tokensFromPaste, tokensFromRedirect, whoami,
} from "./auth.js";

const ENV = ["SHEET_KIT_CONFIG_DIR", "SHEET_KIT_ACCESS_TOKEN", "SHEET_KIT_REFRESH_TOKEN"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function withConfig(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sheet-kit-auth-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  for (const k of ENV) delete process.env[k];
  process.env.SHEET_KIT_CONFIG_DIR = dir;
  return dir;
}

const noFetch = async () => { throw new Error("no fetch expected"); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("SHEET_KIT_ACCESS_TOKEN wins over everything", async () => {
  withConfig({ "token.json": { access_token: "stored", refresh_token: "r", expiry: 1e15 } });
  process.env.SHEET_KIT_ACCESS_TOKEN = "env-token";
  assert.equal(await getAccessToken({ fetchImpl: noFetch }), "env-token");
  assert.equal(credentialSource(), "SHEET_KIT_ACCESS_TOKEN");
});

test("a fresh stored token is returned without a network call", async () => {
  withConfig({ "token.json": { access_token: "a1", refresh_token: "r1", expiry: 10_000_000, scope: "s", email: "x@y.z" } });
  assert.equal(await getAccessToken({ now: () => 1_000, fetchImpl: noFetch }), "a1");
});

test("an expiring token is renewed through the login service and saved", async () => {
  const dir = withConfig({ "token.json": { access_token: "old", refresh_token: "r1", expiry: 1_030, scope: "s", email: "x@y.z" } });
  let call;
  const fetchImpl = async (url, init) => {
    call = { url: String(url), body: JSON.parse(String(init.body)) };
    return json({ access_token: "new", expiry_date: 9_999, scope: "s" });
  };
  assert.equal(await getAccessToken({ now: () => 1_000, fetchImpl }), "new");
  assert.equal(call.url, `${LOGIN_SERVICE}/refreshToken`);
  assert.deepEqual(call.body, { refresh_token: "r1" });
  const stored = JSON.parse(readFileSync(join(dir, "token.json"), "utf8"));
  assert.equal(stored.access_token, "new");
  assert.equal(stored.refresh_token, "r1");
  assert.equal(stored.expiry, 9_999);
});

test("SHEET_KIT_REFRESH_TOKEN alone signs in without a token file or client", async () => {
  const dir = withConfig();
  process.env.SHEET_KIT_REFRESH_TOKEN = "r-env";
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return json({ access_token: "from-env", expiry_date: 1 });
  };
  assert.equal(await getAccessToken({ fetchImpl }), "from-env");
  assert.deepEqual(body, { refresh_token: "r-env" });
  assert.equal(credentialSource(), "SHEET_KIT_REFRESH_TOKEN");
  assert.ok(!existsSync(join(dir, "token.json")), "env credentials never write files");
});

test("invalid_grant says the sign-in was revoked or expired and to log in again", async () => {
  withConfig({ "token.json": { access_token: "old", refresh_token: "secret-r1", expiry: 0, scope: "s", email: "x@y.z" } });
  const fetchImpl = async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
  await assert.rejects(getAccessToken({ fetchImpl }), (e) => {
    assert.match(e.message, /revoked or has expired\. Run `sheet-kit auth login` again/);
    assert.doesNotMatch(e.message, /secret-r1/, "never echo the token");
    return true;
  });
});

test("not signed in gives an actionable error", async () => {
  withConfig();
  await assert.rejects(getAccessToken({ fetchImpl: noFetch }), /sheet-kit auth login/);
  assert.equal(credentialSource(), "");
});

test("authUrl sends Google to the login service with our loopback in the state, drive scope only", () => {
  const q = new URL(authUrl({ uri: "http://127.0.0.1:5555/oauth2callback", csrf: "c1", account: "a@b.c", expectDomain: "b.c" })).searchParams;
  assert.equal(q.get("client_id"), CLIENT_ID);
  assert.equal(CLIENT_ID, "338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com");
  assert.equal(q.get("redirect_uri"), LOGIN_SERVICE);
  assert.equal(q.get("scope"), "https://www.googleapis.com/auth/drive");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("login_hint"), "a@b.c");
  assert.equal(q.get("hd"), "b.c");
  assert.deepEqual(JSON.parse(Buffer.from(q.get("state"), "base64").toString()), { uri: "http://127.0.0.1:5555/oauth2callback", manual: false, csrf: "c1" });
  const manual = new URL(authUrl({ csrf: "c2" })).searchParams.get("state");
  assert.deepEqual(JSON.parse(Buffer.from(manual, "base64").toString()), { manual: true, csrf: "c2" });
});

test("tokensFromRedirect checks the CSRF value and requires a refresh token", () => {
  const q = new URLSearchParams({ access_token: "a", refresh_token: "r", expiry_date: "123", scope: "s", state: "c1" });
  assert.deepEqual(tokensFromRedirect(q, "c1"), { access_token: "a", refresh_token: "r", expiry_date: 123, scope: "s" });
  assert.throws(() => tokensFromRedirect(q, "other"), /state mismatch/);
  assert.throws(() => tokensFromRedirect(new URLSearchParams({ access_token: "a", expiry_date: "1", state: "c1" }), "c1"), /no refresh token/);
});

test("tokensFromPaste reads the sign-in page's credentials JSON", () => {
  const t = tokensFromPaste(JSON.stringify({ refresh_token: "r", scope: "s", token_type: "Bearer", access_token: "a", expiry_date: 5 }));
  assert.deepEqual(t, { access_token: "a", refresh_token: "r", expiry_date: 5, scope: "s" });
  assert.throws(() => tokensFromPaste("not json"), /credentials JSON/);
  assert.throws(() => tokensFromPaste("{}"), /no access_token/);
});

test("checkDomain", () => {
  assert.equal(checkDomain("steven@adeptmind.ai", "adeptmind.ai"), "");
  assert.equal(checkDomain("Steven@AdeptMind.ai", "@adeptmind.ai"), "");
  assert.match(checkDomain("someone@gmail.com", "adeptmind.ai"), /expected an @adeptmind\.ai account/);
  assert.equal(checkDomain("someone@gmail.com", undefined), "");
});

test("whoami reads the account from Drive about", async () => {
  let call;
  const email = await whoami("tok", async (url, init) => {
    call = { url: String(url), auth: init.headers.Authorization };
    return json({ user: { emailAddress: "a@b.co" } });
  });
  assert.equal(email, "a@b.co");
  assert.match(call.url, /drive\/v3\/about\?fields=user\(emailAddress\)/);
  assert.equal(call.auth, "Bearer tok");
});

/** A fake Google: Drive about answers with `email`; revoke calls are recorded. */
function fakeGoogle(email) {
  const revoked = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/revoke")) { revoked.push(u); return json({}); }
    return json({ user: { emailAddress: email } });
  };
  return { fetchImpl, revoked };
}

/** Play the login service: redirect to the loopback port in `state` with tokens. */
function loginService(tokens) {
  return (url) => {
    const state = JSON.parse(Buffer.from(new URL(url).searchParams.get("state"), "base64").toString());
    const target = new URL(state.uri);
    target.search = new URLSearchParams({ ...tokens, state: state.csrf }).toString();
    setImmediate(() => fetch(target).catch(() => {}));
  };
}

test("login stores the loopback tokens, and refuses (and revokes) the wrong domain", async () => {
  const dir = withConfig();
  const tokens = { access_token: "at", refresh_token: "rt", expiry_date: "9999", scope: "https://www.googleapis.com/auth/drive" };

  const wrong = fakeGoogle("me@gmail.com");
  await assert.rejects(
    login({ expectDomain: "adeptmind.ai", fetchImpl: wrong.fetchImpl, openUrl: loginService(tokens) }),
    /expected an @adeptmind\.ai account; token discarded/,
  );
  assert.match(wrong.revoked[0], /token=rt/);
  assert.ok(!existsSync(join(dir, "token.json")));

  const right = fakeGoogle("me@adeptmind.ai");
  assert.equal(await login({ expectDomain: "adeptmind.ai", fetchImpl: right.fetchImpl, openUrl: loginService(tokens) }), "me@adeptmind.ai");
  const stored = JSON.parse(readFileSync(join(dir, "token.json"), "utf8"));
  assert.deepEqual(stored, { access_token: "at", refresh_token: "rt", expiry: 9999, scope: "https://www.googleapis.com/auth/drive", email: "me@adeptmind.ai" });
});

test("--paste login stores the pasted credentials; logout revokes and deletes", async () => {
  const dir = withConfig();
  const google = fakeGoogle("me@x.co");
  const paste = JSON.stringify({ access_token: "a", refresh_token: "rt-2", expiry_date: 5, scope: "s" });
  assert.equal(await loginWithPaste({ readPaste: async () => paste, fetchImpl: google.fetchImpl }), "me@x.co");
  assert.equal(JSON.parse(readFileSync(join(dir, "token.json"), "utf8")).refresh_token, "rt-2");

  assert.equal(await logout(google.fetchImpl), true);
  assert.match(google.revoked[0], /revoke\?token=rt-2/);
  assert.ok(!existsSync(join(dir, "token.json")));
  assert.equal(await logout(google.fetchImpl), false);
});
