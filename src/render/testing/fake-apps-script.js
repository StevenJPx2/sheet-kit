// An in-memory SpreadsheetApp covering what the compiled bundle calls (core.js
// renderTab + every primitive's render) in a full render. It runs the real
// generated sheetkit.gs in a vm sandbox and records the result in the same
// normalized snapshot shape as fake-sheets-api.js, so the legacy Apps Script
// renderer and the Sheets API renderer can be compared offline.
import vm from "node:vm";
import { rendererSource } from "../../utils/compiler.js";

/** @typedef {Record<string, any>} Obj */

/** "#abc" / "#AABBCC" → "#aabbcc". @param {string} c */
function hex(c) {
  let h = String(c).trim().toLowerCase().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(h)) h = h.replace(/./g, "$&$&");
  return `#${h}`;
}

/** @param {Obj} a @param {Obj} b */
const overlaps = (a, b) => a.r0 < b.r1 && b.r0 < a.r1 && a.c0 < b.c1 && b.c0 < a.c1;

function newSheet(/** @type {Obj} */ book, /** @type {string} */ name) {
  /** @type {Obj} */
  const s = {
    name, hidden: false, maxRows: 1000, maxColumns: 26, frozenRows: 0, frozenColumns: 0,
    cells: new Map(), merges: [], cf: [], charts: [], metadata: new Map(),
    rowHeights: new Map(), colWidths: new Map(), hiddenRows: new Set(), hiddenColumns: new Set(),
  };
  const cell = (/** @type {number} */ r, /** @type {number} */ c) => {
    const key = `${r},${c}`;
    if (!s.cells.has(key)) s.cells.set(key, { format: {} });
    return s.cells.get(key);
  };
  const extent = () => {
    let rows = 0, cols = 0;
    for (const [key, v] of s.cells) {
      if (v.value === undefined) continue;
      const [r, c] = key.split(",").map(Number);
      rows = Math.max(rows, r + 1); cols = Math.max(cols, c + 1);
    }
    return { rows, cols };
  };

  /** A range: 1-based row/col like getRange. */
  const range = (/** @type {number} */ row, /** @type {number} */ col, nr = 1, nc = 1) => {
    if (row + nr - 1 > s.maxRows) s.maxRows = row + nr - 1;
    const b = { r0: row - 1, r1: row - 1 + nr, c0: col - 1, c1: col - 1 + nc };
    const each = (/** @type {(c: Obj, r: number, k: number) => void} */ fn) => {
      for (let r = b.r0; r < b.r1; r++) for (let k = b.c0; k < b.c1; k++) fn(cell(r, k), r - b.r0, k - b.c0);
      return api;
    };
    const fmt = (/** @type {string} */ key, /** @type {unknown} */ v) => each((c) => { if (v === undefined) delete c.format[key]; else c.format[key] = v; });
    /** @type {Obj} */
    const api = {
      _b: b, _sheet: s,
      breakApart() { s.merges = s.merges.filter((/** @type {Obj} */ m) => !overlaps(m, b)); return api; },
      clearFormat() { return each((c) => { c.format = {}; }); },
      clear() { return each((c) => { c.format = {}; delete c.value; }); },
      merge() {
        if (b.c0 < s.frozenColumns && b.c1 > s.frozenColumns) throw new Error("You can't merge frozen and non-frozen columns");
        if (!s.merges.some((/** @type {Obj} */ m) => m.r0 === b.r0 && m.r1 === b.r1 && m.c0 === b.c0 && m.c1 === b.c1)) {
          if (s.merges.some((/** @type {Obj} */ m) => overlaps(m, b))) throw new Error("merge overlaps an existing merge");
          s.merges.push({ ...b });
        }
        return api;
      },
      setValues(/** @type {unknown[][]} */ values) { return each((c, r, k) => { const v = values[r][k]; if (v === "" || v == null) delete c.value; else c.value = v; }); },
      getValues() { const out = []; for (let r = b.r0; r < b.r1; r++) { const line = []; for (let k = b.c0; k < b.c1; k++) line.push(s.cells.get(`${r},${k}`)?.value ?? ""); out.push(line); } return out; },
      getDisplayValues() { return api.getValues().map((/** @type {unknown[]} */ l) => l.map((v) => String(v))); },
      setNumberFormat(/** @type {string} */ p) { return fmt("nf", p); },
      setFontWeight(/** @type {string} */ w) { return fmt("bold", w === "bold" ? true : undefined); },
      setFontStyle(/** @type {string} */ st) { return fmt("italic", st === "italic" ? true : undefined); },
      setHorizontalAlignment(/** @type {string} */ a) { return fmt("align", a); },
      setWrap(/** @type {boolean} */ w) { return fmt("wrap", w ? "WRAP" : "OVERFLOW"); },
      setBackground(/** @type {string} */ c) { return fmt("bg", hex(c)); },
      setFontColor(/** @type {string} */ c) { return fmt("color", hex(c)); },
      setFontSize(/** @type {number} */ n) { return fmt("size", n); },
    };
    return api;
  };

  Object.assign(s, {
    getName: () => s.name,
    getParent: () => book.api,
    getIndex: () => book.sheets.indexOf(s) + 1,
    getRange: range,
    getLastRow: () => extent().rows,
    getLastColumn: () => extent().cols,
    getMaxRows: () => s.maxRows,
    getMaxColumns: () => s.maxColumns,
    setFrozenRows: (/** @type {number} */ n) => { s.frozenRows = n; },
    setFrozenColumns: (/** @type {number} */ n) => { s.frozenColumns = n; },
    clearContents: () => { for (const c of s.cells.values()) delete c.value; },
    setRowHeights: (/** @type {number} */ r, /** @type {number} */ n, /** @type {number} */ h) => { for (let i = 0; i < n; i++) s.rowHeights.set(r - 1 + i, h); },
    setRowHeight: (/** @type {number} */ r, /** @type {number} */ h) => { s.rowHeights.set(r - 1, h); },
    autoResizeRows: (/** @type {number} */ r, /** @type {number} */ n) => { for (let i = 0; i < n; i++) s.rowHeights.set(r - 1 + i, "auto"); },
    setColumnWidth: (/** @type {number} */ c, /** @type {number} */ w) => { s.colWidths.set(c - 1, w); },
    setConditionalFormatRules: (/** @type {Obj[]} */ rules) => { s.cf = rules.slice(); },
    getCharts: () => s.charts.slice(),
    removeChart: (/** @type {Obj} */ c) => { s.charts.splice(s.charts.indexOf(c), 1); },
    newChart: () => chartBuilder(),
    insertChart: (/** @type {Obj} */ c) => { s.charts.push(c); },
    showRows: (/** @type {number} */ r, /** @type {number} */ n) => { for (let i = 0; i < n; i++) s.hiddenRows.delete(r - 1 + i); },
    hideRows: (/** @type {number} */ r, n = 1) => { for (let i = 0; i < n; i++) s.hiddenRows.add(r - 1 + i); },
    showColumns: (/** @type {number} */ c, n = 1) => { for (let i = 0; i < n; i++) s.hiddenColumns.delete(c - 1 + i); },
    hideColumns: (/** @type {number} */ c, n = 1) => { for (let i = 0; i < n; i++) s.hiddenColumns.add(c - 1 + i); },
    isSheetHidden: () => s.hidden,
    hideSheet: () => { s.hidden = true; },
    showSheet: () => { s.hidden = false; },
    createDeveloperMetadataFinder: () => ({
      withKey: (/** @type {string} */ k) => ({
        find: () => (s.metadata.has(k) ? [{ getValue: () => s.metadata.get(k), setValue: (/** @type {string} */ v) => s.metadata.set(k, v) }] : []),
      }),
    }),
    addDeveloperMetadata: (/** @type {string} */ k, /** @type {string} */ v) => { s.metadata.set(k, v); },
  });
  return s;
}

function chartBuilder() {
  /** @type {Obj} */
  const c = { ranges: [], options: {}, headers: undefined, title: null, anchor: null, showHidden: false };
  /** @type {Obj} */
  const b = {
    asLineChart: () => b,
    addRange: (/** @type {Obj} */ r) => { c.ranges.push([r._b.r0 + 1, r._b.c0 + 1, r._b.r1 - r._b.r0, r._b.c1 - r._b.c0]); return b; },
    setNumHeaders: (/** @type {number} */ n) => { c.headers = n; return b; },
    setTitle: (/** @type {string} */ t) => { c.title = t; return b; },
    setOption: (/** @type {string} */ k, /** @type {unknown} */ v) => { c.options[k] = v; return b; },
    // Apps Script anchors are 1-based; a 0 column is treated as the first column.
    setPosition: (/** @type {number} */ row, /** @type {number} */ col) => { c.anchor = [row || 1, Math.max(col || 1, 1)]; return b; },
    setHiddenDimensionStrategy: (/** @type {string} */ s) => { c.showHidden = s === "SHOW_BOTH"; return b; },
    build: () => c,
  };
  return b;
}

function ruleBuilder() {
  /** @type {Obj} */
  const r = { ranges: [], format: {} };
  /** @type {Obj} */
  const b = {
    setGradientMinpoint: (/** @type {string} */ c) => { r.min = { color: hex(c), type: "MIN" }; return b; },
    setGradientMaxpoint: (/** @type {string} */ c) => { r.max = { color: hex(c), type: "MAX" }; return b; },
    setGradientMinpointWithValue: (/** @type {string} */ c, /** @type {string} */ t, /** @type {string} */ v) => { r.min = { color: hex(c), type: t, value: v }; return b; },
    setGradientMidpointWithValue: (/** @type {string} */ c, /** @type {string} */ t, /** @type {string} */ v) => { r.mid = { color: hex(c), type: t, value: v }; return b; },
    setGradientMaxpointWithValue: (/** @type {string} */ c, /** @type {string} */ t, /** @type {string} */ v) => { r.max = { color: hex(c), type: t, value: v }; return b; },
    whenTextEqualTo: (/** @type {string} */ v) => { r.when = { type: "TEXT_EQ", value: v }; return b; },
    whenFormulaSatisfied: (/** @type {string} */ f) => { r.when = { type: "CUSTOM_FORMULA", value: f }; return b; },
    setBold: () => { r.format.bold = true; return b; },
    setItalic: () => { r.format.italic = true; return b; },
    setStrikethrough: () => { r.format.strike = true; return b; },
    setUnderline: () => b,
    setFontColor: (/** @type {string} */ c) => { r.format.color = hex(c); return b; },
    setBackground: (/** @type {string} */ c) => { r.format.bg = hex(c); return b; },
    setRanges: (/** @type {Obj[]} */ ranges) => { r.ranges = ranges.map((x) => [x._b.r0 + 1, x._b.c0 + 1, x._b.r1 - x._b.r0, x._b.c1 - x._b.c0]); return b; },
    build: () => r,
  };
  return b;
}

/**
 * A spreadsheet with the given tab names, plus a runner for the compiled
 * renderer of `tabs`.
 * @param {string[]} names
 */
export function fakeAppsScript(names = ["Sheet1"]) {
  /** @type {Obj} */
  const book = { sheets: [], active: null };
  book.api = {
    getSheetByName: (/** @type {string} */ n) => book.sheets.find((/** @type {Obj} */ s) => s.name === n) ?? null,
    insertSheet: (/** @type {string} */ n, /** @type {number} */ index) => { const s = newSheet(book, n); book.sheets.splice(index, 0, s); return s; },
    getNumSheets: () => book.sheets.length,
    setActiveSheet: (/** @type {Obj} */ s) => { book.active = s; s.hidden = false; },
    moveActiveSheet: (/** @type {number} */ pos) => { book.sheets.splice(book.sheets.indexOf(book.active), 1); book.sheets.splice(pos - 1, 0, book.active); },
  };
  for (const n of names) book.sheets.push(newSheet(book, n));

  const INTERP = { NUMBER: "NUMBER", PERCENT: "PERCENT", PERCENTILE: "PERCENTILE", MIN: "MIN", MAX: "MAX" };
  return {
    book,
    /**
     * Run the compiled bundle's renderTab for every tab with a dataset.
     * @param {import("../../types.js").Manifest} manifest
     * @param {import("../../types.js").Data} data
     */
    render(manifest, data) {
      const sandbox = {
        SpreadsheetApp: { newConditionalFormatRule: ruleBuilder, InterpolationType: INTERP, flush() {} },
        Charts: { ChartHiddenDimensionStrategy: { SHOW_BOTH: "SHOW_BOTH" } },
      };
      vm.createContext(sandbox);
      vm.runInContext(rendererSource(manifest.tabs), sandbox);
      const renderTab = /** @type {any} */ (sandbox).renderTab;
      return manifest.tabs
        .filter((t) => Object.prototype.hasOwnProperty.call(data.datasets, t.data_key))
        .map((t) => renderTab(book.api, t, data.datasets[t.data_key], { force: true }));
    },
    snapshot: () => JSON.parse(JSON.stringify(snapshot(book))),
  };
}

/** @param {Obj} book */
function snapshot(book) {
  return {
    order: book.sheets.map((/** @type {Obj} */ s) => s.name),
    sheets: Object.fromEntries(book.sheets.map((/** @type {Obj} */ s) => [s.name, {
      hidden: s.hidden,
      frozen: [s.frozenRows, s.frozenColumns],
      cells: Object.fromEntries([...s.cells].map(([key, c]) => {
        /** @type {Obj} */
        const out = {};
        if (c.value !== undefined) out.v = c.value;
        for (const k of ["nf", "bold", "italic", "size", "color", "bg", "align", "wrap"]) if (c.format[k] !== undefined) out[k] = c.format[k];
        return [key, out];
      }).filter(([, v]) => Object.keys(v).length).sort(byKey)),
      merges: s.merges.map((/** @type {Obj} */ m) => `${m.r0},${m.c0}:${m.r1},${m.c1}`).sort(),
      rowHeights: Object.fromEntries([...s.rowHeights].filter(([, v]) => v !== 21)),
      colWidths: Object.fromEntries(s.colWidths),
      hiddenRows: [...s.hiddenRows].sort((a, b) => a - b),
      hiddenColumns: [...s.hiddenColumns].sort((a, b) => a - b),
      cf: s.cf.map((/** @type {Obj} */ r) => (r.min
        ? { ranges: r.ranges, gradient: { min: r.min, mid: r.mid ?? null, max: r.max } }
        : { ranges: r.ranges, when: r.when, format: { bold: Boolean(r.format.bold), italic: Boolean(r.format.italic), strike: Boolean(r.format.strike), color: r.format.color, bg: r.format.bg } })),
      charts: s.charts.map((/** @type {Obj} */ c) => {
        const colors = (c.options.colors ?? []).map(hex);
        return {
          ranges: c.ranges,
          title: c.title,
          headers: c.headers,
          colors: c.ranges.slice(1).map((/** @type {unknown} */ _, /** @type {number} */ i) => colors[i] ?? null),
          anchor: c.anchor,
          size: [c.options.width, c.options.height],
          showHidden: c.showHidden,
        };
      }),
    }])),
  };
}

/** @param {[string, unknown]} a @param {[string, unknown]} b */
function byKey(a, b) {
  const [ar, ac] = a[0].split(",").map(Number);
  const [br, bc] = b[0].split(",").map(Number);
  return ar - br || ac - bc;
}
