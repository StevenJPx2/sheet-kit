import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeSheetsApi } from "../render/testing/fake-sheets-api.js";
import { renderManifest } from "../render/render.js";

async function render(api, placement) {
  const manifest = { contract_version: 1, spreadsheet_id: "SHEET", tabs: [{
    name: "History", data_key: "history", columns: [{ name: "Value", type: "number", source_field: "v" }], placement,
  }] };
  return renderManifest(manifest, { contract_version: 1, datasets: { history: [{ v: 1 }] } }, { token: "t", deps: { fetchImpl: api.fetchImpl } });
}

const book = () => fakeSheetsApi({ sheets: ["A", "History", "B", "C"].map((title) => ({ title })) });

test("position last moves the tab to the end and repeated renders keep it there", async () => {
  const api = book();
  await render(api, { position: "last" });
  assert.deepEqual(api.snapshot().order, ["A", "B", "C", "History"]);
  await render(api, { position: "last" });
  assert.deepEqual(api.snapshot().order, ["A", "B", "C", "History"]);
});

test("hidden true hides once; false shows; absent preserves a manual hide", async () => {
  const api = book();
  await render(api, { hidden: true });
  assert.equal(api.snapshot().sheets.History.hidden, true);
  api.book.log.length = 0;
  await render(api, { hidden: true });
  assert.ok(!api.book.log.flatMap((c) => c.body?.requests ?? []).some((r) => r.updateSheetProperties?.fields === "hidden"));
  await render(api, {});
  assert.equal(api.snapshot().sheets.History.hidden, true);
  await render(api, { hidden: false });
  assert.equal(api.snapshot().sheets.History.hidden, false);
});

test("moving a hidden tab keeps it hidden", async () => {
  const api = book();
  await render(api, { hidden: true });
  await render(api, { position: "first", hidden: true });
  assert.deepEqual(api.snapshot().order, ["History", "A", "B", "C"]);
  assert.equal(api.snapshot().sheets.History.hidden, true);
});
