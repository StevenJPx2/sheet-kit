import assert from "node:assert/strict";
import { test } from "node:test";
import { sheetsClient } from "./sheets.js";

test("USER_ENTERED quotes literal strings without changing formulas, numbers, booleans or input grids", async () => {
  let body;
  const client = sheetsClient("S", "t", { fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init.body));
    return Response.json({});
  } });
  const values = [["+$6,527", "-$21,397", "+10.6%", "00123", "2026-10-25", "'quoted", "=SUM(A2:B2)", 12, true, ""]];
  const original = structuredClone(values);
  await client.writeValues([{ range: "'Overview'!A1", majorDimension: "ROWS", values }]);
  assert.equal(body.valueInputOption, "USER_ENTERED");
  assert.deepEqual(body.data[0].values, [["'+$6,527", "'-$21,397", "'+10.6%", "'00123", "'2026-10-25", "''quoted", "=SUM(A2:B2)", 12, true, ""]]);
  assert.deepEqual(values, original);
});
