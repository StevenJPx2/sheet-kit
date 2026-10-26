import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deployAppsScript, readProjectFiles } from "./deploy.js";

const MANIFEST = JSON.stringify({ timeZone: "Etc/UTC", runtimeVersion: "V8", webapp: { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" } });

/** A compiled project dir like `sheet-kit compile` writes, plus noise that must not be pushed. */
function project(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sheet-kit-deploy-"));
  const files = {
    "appsscript.json": MANIFEST,
    "sheetkit.gs": "function renderTab() {}\n",
    "webhook.gs": "function doPost() {}\n",
    "manifest.gs": "var SHEETKIT_MANIFEST = {};\n",
    "README.md": "not pushed",
    ".clasp.json": "{}",
    ...extra,
  };
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

/** Records every call and answers with the canned body for the matching step. */
function recorder(deploymentId = "AKfy-new") {
  /** @type {{ method: string, url: string, body: any, auth: string }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const call = { method: String(init?.method), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: init?.headers?.Authorization };
    calls.push(call);
    if (call.url.endsWith("/content")) return Response.json({ scriptId: "S1", files: call.body.files });
    if (call.url.endsWith("/versions")) return Response.json({ versionNumber: 7, description: call.body.description });
    const id = call.method === "PUT" ? decodeURIComponent(call.url.split("/deployments/")[1]) : deploymentId;
    return Response.json({
      deploymentId: id,
      deploymentConfig: call.body.deploymentConfig ?? call.body,
      entryPoints: [{ entryPointType: "WEB_APP", webApp: { url: `https://script.google.com/macros/s/${id}/exec` } }],
    });
  };
  return { calls, fetchImpl };
}

test("readProjectFiles maps compile output to Apps Script file types", () => {
  const files = readProjectFiles(project({ "sidebar.html": "<p/>" }));
  assert.deepEqual(files.map((f) => [f.name, f.type]), [
    ["appsscript", "JSON"],
    ["manifest", "SERVER_JS"],
    ["sheetkit", "SERVER_JS"],
    ["sidebar", "HTML"],
    ["webhook", "SERVER_JS"],
  ]);
  assert.equal(files[0].source, MANIFEST);
});

test("readProjectFiles requires the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-kit-deploy-"));
  writeFileSync(join(dir, "a.gs"), "");
  assert.throws(() => readProjectFiles(dir), /missing generated Apps Script manifest/);
});

test("redeploying a deployment id: updateContent, versions.create, deployments.update on the same id", async () => {
  const dir = project();
  const { calls, fetchImpl } = recorder();
  const result = await deployAppsScript(
    { projectDir: dir, scriptId: "S1", deploymentId: "AKfy-prod", description: "sheet-kit generated (acme)" },
    { token: "tok", fetchImpl },
  );

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "PUT https://script.googleapis.com/v1/projects/S1/content",
    "POST https://script.googleapis.com/v1/projects/S1/versions",
    "PUT https://script.googleapis.com/v1/projects/S1/deployments/AKfy-prod",
  ]);
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
  assert.deepEqual(calls[0].body.files.map((f) => f.name), ["appsscript", "manifest", "sheetkit", "webhook"]);
  assert.deepEqual(calls[1].body, { description: "sheet-kit generated (acme)" });
  assert.deepEqual(calls[2].body, {
    deploymentConfig: { scriptId: "S1", versionNumber: 7, manifestFileName: "appsscript", description: "sheet-kit generated (acme)" },
  });

  assert.equal(result.deploymentId, "AKfy-prod");
  assert.equal(result.url, "https://script.google.com/macros/s/AKfy-prod/exec");
  assert.equal(result.created, false);
  assert.equal(result.versionNumber, 7);
});

test("without --deployment-id a new deployment is created", async () => {
  const { calls, fetchImpl } = recorder("AKfy-new");
  const result = await deployAppsScript({ projectDir: project(), scriptId: "S1" }, { token: "tok", fetchImpl });

  assert.equal(calls[2].method, "POST");
  assert.equal(calls[2].url, "https://script.googleapis.com/v1/projects/S1/deployments");
  assert.deepEqual(calls[2].body, { versionNumber: 7, manifestFileName: "appsscript", description: "" });
  assert.equal(result.deploymentId, "AKfy-new");
  assert.equal(result.created, true);
});

test("an existing .clasp.json still supplies the script id and rootDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "sheet-kit-deploy-"));
  const src = join(root, "src");
  mkdirSync(src);
  writeFileSync(join(src, "appsscript.json"), MANIFEST);
  writeFileSync(join(src, "webhook.gs"), "function doPost() {}\n");
  writeFileSync(join(root, ".clasp.json"), JSON.stringify({ scriptId: "FROM-CLASP", rootDir: "src" }));

  const { calls, fetchImpl } = recorder();
  await deployAppsScript({ projectDir: root, deploymentId: "D" }, { token: "tok", fetchImpl });
  assert.equal(calls[0].url, "https://script.googleapis.com/v1/projects/FROM-CLASP/content");
  assert.deepEqual(calls[0].body.files.map((f) => f.name), ["appsscript", "webhook"]);
});

test("no --script-id and no .clasp.json is a usage error before any call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-kit-deploy-"));
  writeFileSync(join(dir, "appsscript.json"), MANIFEST);
  const { calls, fetchImpl } = recorder();
  await assert.rejects(deployAppsScript({ projectDir: dir }, { token: "tok", fetchImpl }), /missing --script-id/);
  assert.equal(calls.length, 0);
});

test("the Apps Script API user setting being off stops the deploy with the fix", async () => {
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return Response.json({
      error: { code: 403, status: "PERMISSION_DENIED", message: "User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry." },
    }, { status: 403 });
  };
  await assert.rejects(
    deployAppsScript({ projectDir: project(), scriptId: "S1", deploymentId: "D" }, { token: "tok", fetchImpl }),
    /turned off for your account.*script\.google\.com\/home\/usersettings/,
  );
  assert.equal(calls.length, 1, "no version or deployment after a failed push");
});

test("the Apps Script API disabled in the Cloud project names the project and link", async () => {
  /** @type {typeof fetch} */
  const fetchImpl = async () => Response.json({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Apps Script API has not been used in project 42 before or it is disabled.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "script.googleapis.com", consumer: "projects/42", activationUrl: "https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=42" } }],
    },
  }, { status: 403 });
  await assert.rejects(
    deployAppsScript({ projectDir: project(), scriptId: "S1" }, { token: "tok", fetchImpl }),
    /script\.googleapis\.com is not enabled in projects\/42.*overview\?project=42/,
  );
});
