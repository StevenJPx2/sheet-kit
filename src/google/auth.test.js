import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkDomain, clientPath, getAccessToken, loadClient, SCOPES, whoami } from "./auth.js";
import { describeError } from "./http.js";

/** Fresh sheet-kit and doc-kit config dirs; returns both paths. */
function withConfig(files = {}, docKitFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-auth-"));
  const own = join(root, "sheet-kit");
  const docKit = join(root, "doc-kit");
  mkdirSync(own);
  mkdirSync(docKit);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(own, name), JSON.stringify(value));
  for (const [name, value] of Object.entries(docKitFiles)) writeFileSync(join(docKit, name), JSON.stringify(value));
  process.env.SHEET_KIT_CONFIG_DIR = own;
  process.env.DOC_KIT_CONFIG_DIR = docKit;
  delete process.env.SHEET_KIT_ACCESS_TOKEN;
  return { own, docKit };
}

test("SHEET_KIT_ACCESS_TOKEN wins over everything", async () => {
  withConfig();
  process.env.SHEET_KIT_ACCESS_TOKEN = "env-token";
  try {
    assert.equal(await getAccessToken(), "env-token");
  } finally {
    delete process.env.SHEET_KIT_ACCESS_TOKEN;
  }
});

test("a fresh stored token is returned without a network call", async () => {
  withConfig({ "token.json": { access_token: "a1", refresh_token: "r1", expiry: 10_000_000, scope: "s", email: "x@y.z" } });
  const token = await getAccessToken({ now: () => 1_000, fetchImpl: async () => { throw new Error("no fetch expected"); } });
  assert.equal(token, "a1");
});

test("an expiring token is refreshed with the client and saved", async () => {
  const { own } = withConfig({
    "token.json": { access_token: "old", refresh_token: "r1", expiry: 1_030, scope: "s", email: "x@y.z" },
    "client.json": { installed: { client_id: "cid", client_secret: "secret" } },
  });
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = new URLSearchParams(String(init.body));
    return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
  };
  const token = await getAccessToken({ now: () => 1_000, fetchImpl });
  assert.equal(token, "new");
  assert.equal(sent.get("grant_type"), "refresh_token");
  assert.equal(sent.get("refresh_token"), "r1");
  assert.equal(sent.get("client_id"), "cid");
  assert.equal(sent.get("client_secret"), "secret");
  const saved = JSON.parse(readFileSync(join(own, "token.json"), "utf8"));
  assert.equal(saved.access_token, "new");
  assert.equal(saved.refresh_token, "r1");
  assert.equal(saved.expiry, 1_000 + 3_600_000);
});

test("refresh falls back to doc-kit's client.json when sheet-kit has none", async () => {
  const { docKit } = withConfig(
    { "token.json": { access_token: "old", refresh_token: "r1", expiry: 0, scope: "s", email: "x@y.z" } },
    { "client.json": { installed: { client_id: "doc-kit-cid", client_secret: "doc-kit-secret" } } },
  );
  assert.equal(clientPath(), join(docKit, "client.json"));
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = new URLSearchParams(String(init.body));
    return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
  };
  assert.equal(await getAccessToken({ now: () => 1_000, fetchImpl }), "new");
  assert.equal(sent.get("client_id"), "doc-kit-cid");
});

test("sheet-kit's own client.json wins over doc-kit's", () => {
  const { own } = withConfig(
    { "client.json": { installed: { client_id: "own", client_secret: "s" } } },
    { "client.json": { installed: { client_id: "doc-kit", client_secret: "s" } } },
  );
  assert.equal(clientPath(), join(own, "client.json"));
  assert.equal(loadClient().client_id, "own");
});

test("not signed in, and no client anywhere, give actionable errors", async () => {
  const { own } = withConfig();
  await assert.rejects(getAccessToken(), /sheet-kit auth login/);
  assert.equal(clientPath(), join(own, "client.json"));
  assert.throws(() => loadClient(), /--client/);
});

test("a failed refresh surfaces the token endpoint's reason", async () => {
  withConfig({
    "token.json": { access_token: "old", refresh_token: "r1", expiry: 0, scope: "s", email: "x@y.z" },
    "client.json": { installed: { client_id: "cid", client_secret: "secret" } },
  });
  const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });
  await assert.rejects(getAccessToken({ now: () => 1_000, fetchImpl }), /token endpoint 400: Token has been expired or revoked/);
});

test("checkDomain", () => {
  assert.equal(checkDomain("steven@adeptmind.ai", "adeptmind.ai"), "");
  assert.equal(checkDomain("Steven@AdeptMind.ai", "@adeptmind.ai"), "");
  assert.match(checkDomain("someone@gmail.com", "adeptmind.ai"), /expected an @adeptmind\.ai account/);
  assert.equal(checkDomain("someone@gmail.com", undefined), "");
});

test("whoami reads the OpenID userinfo email with the bearer token", async () => {
  let call;
  const fetchImpl = async (url, init) => {
    call = { url: String(url), init };
    return new Response(JSON.stringify({ sub: "1", email: "me@adeptmind.ai" }), { status: 200 });
  };
  assert.equal(await whoami("tok", fetchImpl), "me@adeptmind.ai");
  assert.equal(call.url, "https://openidconnect.googleapis.com/v1/userinfo");
  assert.equal(call.init.headers.Authorization, "Bearer tok");
});

test("scopes cover deploy and inspect only", () => {
  assert.deepEqual(SCOPES, [
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "openid",
    "email",
  ]);
});

test("describeError explains the two classic Apps Script API failures", () => {
  const userSetting = describeError(403, {
    error: { code: 403, status: "PERMISSION_DENIED", message: "User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry." },
  });
  assert.match(userSetting, /turned off for your account/);
  assert.match(userSetting, /script\.google\.com\/home\/usersettings/);

  const disabled = describeError(403, {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Apps Script API has not been used in project 123 before or it is disabled.",
      details: [{ reason: "SERVICE_DISABLED", metadata: { service: "script.googleapis.com", consumer: "projects/123", activationUrl: "https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=123" } }],
    },
  });
  assert.match(disabled, /script\.googleapis\.com is not enabled in projects\/123/);
  assert.match(disabled, /Enable it: https:\/\/console\.developers\.google\.com/);

  assert.match(describeError(401, { error: { message: "Invalid Credentials" } }), /sheet-kit auth login/);
  assert.equal(describeError(404, { error: { message: "Requested entity was not found." } }), "HTTP 404: Requested entity was not found.");
});
