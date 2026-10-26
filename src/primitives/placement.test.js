import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import placement from "./placement.js";

// A spreadsheet of named tabs that records moves, hides and shows.
function fakeSpreadsheet(names, hidden = []) {
  const ss = { tabs: [], active: null, calls: [] };
  ss.getNumSheets = () => ss.tabs.length;
  ss.setActiveSheet = (sheet) => { ss.active = sheet; sheet.isHidden = false; };
  ss.moveActiveSheet = (pos) => {
    ss.tabs.splice(ss.tabs.indexOf(ss.active), 1);
    ss.tabs.splice(pos - 1, 0, ss.active);
    ss.calls.push(`move ${ss.active.name} ${pos}`);
  };
  for (const name of names) {
    const sheet = { name, isHidden: hidden.includes(name) };
    sheet.getParent = () => ss;
    sheet.getIndex = () => ss.tabs.indexOf(sheet) + 1;
    sheet.isSheetHidden = () => sheet.isHidden;
    sheet.hideSheet = () => { sheet.isHidden = true; ss.calls.push(`hide ${name}`); };
    sheet.showSheet = () => { sheet.isHidden = false; ss.calls.push(`show ${name}`); };
    ss.tabs.push(sheet);
  }
  return ss;
}

function render(sheet, value) {
  const sandbox = {};
  vm.runInNewContext(placement.runtime, sandbox);
  sandbox[placement.fn]({ sheet, spec: { placement: value } });
}

test("position last moves the tab to the end", () => {
  const ss = fakeSpreadsheet(["A", "History", "B", "C"]);
  render(ss.tabs[1], { position: "last" });
  assert.deepEqual(ss.tabs.map((s) => s.name), ["A", "B", "C", "History"]);

  ss.calls.length = 0;
  render(ss.tabs[3], { position: "last" });
  assert.deepEqual(ss.calls, [], "already last: no move");
});

test("hidden true hides once; false shows; absent leaves a manual hide alone", () => {
  const ss = fakeSpreadsheet(["A", "B"], ["B"]);
  render(ss.tabs[0], { hidden: true });
  render(ss.tabs[0], { hidden: true });
  assert.deepEqual(ss.calls, ["hide A"]);

  render(ss.tabs[1], {});
  assert.equal(ss.tabs[1].isHidden, true);

  render(ss.tabs[1], { hidden: false });
  assert.equal(ss.tabs[1].isHidden, false);
});

test("a hidden tab is moved, then hidden again", () => {
  const ss = fakeSpreadsheet(["A", "B", "C"], ["A"]);
  render(ss.tabs[0], { position: "last", hidden: true });
  assert.deepEqual(ss.tabs.map((s) => s.name), ["B", "C", "A"]);
  assert.equal(ss.tabs[2].isHidden, true);
});
