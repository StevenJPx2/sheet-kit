import assert from "node:assert/strict";
import { test } from "node:test";

import { describeError, googleJson } from "./http.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("googleJson retries 429/5xx with growing waits, then succeeds", async () => {
  const statuses = [429, 503, 200];
  const waits = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer t");
    assert.equal(init.headers["Content-Type"], "application/json");
    const status = statuses[calls++];
    return status === 200 ? json({ ok: 1 }) : json({ error: { message: "slow down" } }, status);
  };
  assert.deepEqual(await googleJson("t", "POST", "https://x", { a: 1 }, { fetchImpl, wait: async (ms) => { waits.push(ms); } }), { ok: 1 });
  assert.equal(calls, 3);
  assert.ok(waits[0] >= 1000 && waits[0] < 2000);
  assert.ok(waits[1] >= 2000 && waits[1] < 3000);
});

test("googleJson gives up after 5 attempts and never retries a 400", async () => {
  let calls = 0;
  const busy = async () => { calls++; return json({ error: { message: "quota" } }, 429); };
  await assert.rejects(googleJson("t", "GET", "https://x", undefined, { fetchImpl: busy, wait: async () => {} }), /HTTP 429: quota/);
  assert.equal(calls, 5);

  calls = 0;
  const bad = async () => { calls++; return json({ error: { message: "Invalid requests[0]" } }, 400); };
  await assert.rejects(googleJson("t", "GET", "https://x", undefined, { fetchImpl: bad, wait: async () => {} }), /HTTP 400: Invalid requests\[0\]/);
  assert.equal(calls, 1);
});

test("describeError points at the fix", () => {
  assert.match(describeError(401, { error: { message: "bad" } }), /sheet-kit auth login/);
  assert.match(describeError(403, { error: { message: "denied" } }), /can edit this spreadsheet/);
  assert.equal(describeError(500, {}, "<html>"), "HTTP 500: <html>");
});
