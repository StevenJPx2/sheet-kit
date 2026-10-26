// An in-memory Google Sheets behind a `fetch`, for offline renderer tests. It
// serves the calls sheet-kit makes (spreadsheets.get, batchUpdate,
// values.batchUpdate, values.batchGet), applies each batchUpdate request the way
// the Sheets API documents it, and rejects what the API would reject (unknown
// request types, out-of-grid ranges, bad indexes, overlapping merges) with a
// 400, so a malformed request fails the test instead of passing silently.
//
// snapshot() normalizes the result into the same shape as fake-apps-script.js,
// so the two renderers can be compared cell by cell.

/** @typedef {Record<string, any>} Obj */

export function fakeSheetsApi({ spreadsheetId = "SHEET", sheets = [{ title: "Sheet1" }] } = {}) {
  const book = { sheets: /** @type {Obj[]} */ ([]), nextObjectId: 1000, log: /** @type {Obj[]} */ ([]) };
  for (const s of sheets) addSheet(book, { sheetId: s.sheetId ?? book.sheets.length, title: s.title, gridProperties: s.grid });

  /** @param {any} url @param {any} init */
  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const path = decodeURIComponent(u.pathname);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    book.log.push({ method: init.method ?? "GET", path, body });
    try {
      if (!path.startsWith(`/v4/spreadsheets/${spreadsheetId}`)) return reply(404, { error: { message: "not found" } });
      if (path.endsWith(":batchUpdate") && path.includes("/values")) return reply(200, writeValues(book, body));
      if (path.endsWith(":batchUpdate")) { body.requests.forEach((/** @type {Obj} */ r, i) => apply(book, r, i)); return reply(200, {}); }
      if (path.endsWith("/values:batchGet")) return reply(200, readValues(book, u.searchParams.getAll("ranges")));
      return reply(200, metadata(book));
    } catch (e) {
      return reply(400, { error: { message: String(/** @type {Error} */ (e).message) } });
    }
  }
  return { fetchImpl, book, snapshot: () => JSON.parse(JSON.stringify(snapshot(book))) };
}

/** @param {number} status @param {unknown} body */
const reply = (status, body) => new Response(JSON.stringify(body), { status });

/** @param {Obj} book @param {Obj} props */
function addSheet(book, props) {
  if (book.sheets.some((/** @type {Obj} */ s) => s.title === props.title || s.sheetId === props.sheetId)) throw new Error(`duplicate sheet ${props.title}`);
  const g = props.gridProperties ?? {};
  book.sheets.push({
    sheetId: props.sheetId, title: props.title, hidden: false,
    rowCount: g.rowCount ?? 1000, columnCount: g.columnCount ?? 26, frozenRows: 0, frozenColumns: 0,
    cells: new Map(), merges: [], cf: [], charts: [], metadata: [],
    rowHeights: new Map(), colWidths: new Map(), hiddenRows: new Set(), hiddenColumns: new Set(),
  });
}

/** @param {Obj} book @param {number} id */
function sheetById(book, id) {
  const s = book.sheets.find((/** @type {Obj} */ x) => x.sheetId === id);
  if (!s) throw new Error(`no sheet with id ${id}`);
  return s;
}

/** GridRange → 0-based [r0, r1, c0, c1), unbounded sides filled from the grid; rejects out-of-grid. @param {Obj} book @param {Obj} range */
function bounds(book, range) {
  const s = sheetById(book, range.sheetId);
  const b = { s, r0: range.startRowIndex ?? 0, r1: range.endRowIndex ?? s.rowCount, c0: range.startColumnIndex ?? 0, c1: range.endColumnIndex ?? s.columnCount };
  if (b.r0 < 0 || b.c0 < 0 || b.r1 > s.rowCount || b.c1 > s.columnCount || b.r0 > b.r1 || b.c0 > b.c1) {
    throw new Error(`range ${JSON.stringify(range)} is outside the ${s.rowCount}x${s.columnCount} grid of ${s.title}`);
  }
  return b;
}

/** @param {Obj} b @param {(cell: Obj, r: number, c: number) => void} fn */
function eachCell(b, fn) {
  for (let r = b.r0; r < b.r1; r++) {
    for (let c = b.c0; c < b.c1; c++) {
      const key = `${r},${c}`;
      if (!b.s.cells.has(key)) b.s.cells.set(key, { format: {} });
      fn(b.s.cells.get(key), r, c);
    }
  }
}

/** Set a dotted path (e.g. "textFormat.bold") from src into dst. @param {Obj} dst @param {Obj} src @param {string} path */
function copyPath(dst, src, path) {
  const keys = path.split(".");
  let d = dst, sv = src;
  for (let i = 0; i < keys.length - 1; i++) {
    sv = sv?.[keys[i]];
    d[keys[i]] = d[keys[i]] ?? {};
    d = d[keys[i]];
  }
  const last = keys[keys.length - 1];
  const v = sv?.[last];
  if (v === undefined) delete d[last];
  else d[last] = JSON.parse(JSON.stringify(v));
}

const HANDLERS = /** @type {Record<string, (book: Obj, r: Obj) => void>} */ ({
  addSheet(book, r) { addSheet(book, r.properties); },
  updateSheetProperties(book, r) {
    const s = sheetById(book, r.properties.sheetId);
    for (const field of r.fields.split(",")) {
      if (field === "index") moveSheet(book, s, r.properties.index);
      else if (field === "hidden") s.hidden = Boolean(r.properties.hidden);
      else if (field === "gridProperties.rowCount") s.rowCount = r.properties.gridProperties.rowCount;
      else if (field === "gridProperties.columnCount") s.columnCount = r.properties.gridProperties.columnCount;
      else if (field === "gridProperties.frozenRowCount") s.frozenRows = r.properties.gridProperties.frozenRowCount;
      else if (field === "gridProperties.frozenColumnCount") s.frozenColumns = r.properties.gridProperties.frozenColumnCount;
      else throw new Error(`unsupported sheet field ${field}`);
    }
    if (book.sheets.filter((/** @type {Obj} */ x) => !x.hidden).length === 0) throw new Error("can't hide every sheet");
  },
  unmergeCells(book, r) {
    const b = bounds(book, r.range);
    b.s.merges = b.s.merges.filter((/** @type {Obj} */ m) => {
      const inside = m.r0 >= b.r0 && m.r1 <= b.r1 && m.c0 >= b.c0 && m.c1 <= b.c1;
      if (!inside && overlaps(m, b)) throw new Error("unmerge range partially spans a merge");
      return !inside;
    });
  },
  mergeCells(book, r) {
    if (r.mergeType !== "MERGE_ALL") throw new Error(`unsupported mergeType ${r.mergeType}`);
    const b = bounds(book, r.range);
    if (b.c0 < b.s.frozenColumns && b.c1 > b.s.frozenColumns) throw new Error("can't merge across a frozen column");
    const same = b.s.merges.find((/** @type {Obj} */ m) => m.r0 === b.r0 && m.r1 === b.r1 && m.c0 === b.c0 && m.c1 === b.c1);
    if (same) return;
    if (b.s.merges.some((/** @type {Obj} */ m) => overlaps(m, b))) throw new Error("merge overlaps an existing merge");
    b.s.merges.push({ r0: b.r0, r1: b.r1, c0: b.c0, c1: b.c1 });
  },
  updateCells(book, r) {
    if (r.rows) throw new Error("fake supports clearing updateCells only");
    const b = bounds(book, r.range);
    const fields = r.fields.split(",");
    eachCell(b, (cell) => {
      if (fields.includes("userEnteredValue")) delete cell.value;
      if (fields.includes("userEnteredFormat")) cell.format = {};
    });
  },
  repeatCell(book, r) {
    const b = bounds(book, r.range);
    const fields = r.fields.split(",");
    eachCell(b, (cell) => {
      for (const f of fields) {
        if (!f.startsWith("userEnteredFormat.")) throw new Error(`unsupported repeatCell field ${f}`);
        copyPath(cell.format, r.cell.userEnteredFormat, f.slice("userEnteredFormat.".length));
      }
    });
  },
  updateDimensionProperties(book, r) {
    const range = r.range;
    const s = sheetById(book, range.sheetId);
    const limit = range.dimension === "ROWS" ? s.rowCount : s.columnCount;
    if (range.startIndex < 0 || range.endIndex > limit || range.startIndex >= range.endIndex) throw new Error(`dimension range ${JSON.stringify(range)} out of grid`);
    for (let i = range.startIndex; i < range.endIndex; i++) {
      for (const f of r.fields.split(",")) {
        if (f === "pixelSize") (range.dimension === "ROWS" ? s.rowHeights : s.colWidths).set(i, r.properties.pixelSize);
        else if (f === "hiddenByUser") {
          const set = range.dimension === "ROWS" ? s.hiddenRows : s.hiddenColumns;
          if (r.properties.hiddenByUser) set.add(i); else set.delete(i);
        } else throw new Error(`unsupported dimension field ${f}`);
      }
    }
  },
  autoResizeDimensions(book, r) {
    const d = r.dimensions;
    const s = sheetById(book, d.sheetId);
    if (d.dimension !== "ROWS" || d.endIndex > s.rowCount) throw new Error("bad autoResize range");
    for (let i = d.startIndex; i < d.endIndex; i++) s.rowHeights.set(i, "auto");
  },
  addConditionalFormatRule(book, r) {
    const s = sheetById(book, r.rule.ranges[0].sheetId);
    for (const range of r.rule.ranges) bounds(book, range);
    if (!!r.rule.gradientRule === !!r.rule.booleanRule) throw new Error("a rule needs exactly one of gradientRule/booleanRule");
    if (r.index < 0 || r.index > s.cf.length) throw new Error(`cf index ${r.index} out of range`);
    s.cf.splice(r.index, 0, JSON.parse(JSON.stringify(r.rule)));
  },
  deleteConditionalFormatRule(book, r) {
    const s = sheetById(book, r.sheetId);
    if (r.index < 0 || r.index >= s.cf.length) throw new Error(`no cf rule at index ${r.index}`);
    s.cf.splice(r.index, 1);
  },
  addChart(book, r) {
    const chart = JSON.parse(JSON.stringify(r.chart));
    const anchor = chart.position.overlayPosition.anchorCell;
    const s = sheetById(book, anchor.sheetId);
    if (chart.spec.basicChart?.chartType !== "LINE") throw new Error("fake supports LINE charts");
    for (const d of [...chart.spec.basicChart.domains.map((/** @type {Obj} */ x) => x.domain), ...chart.spec.basicChart.series.map((/** @type {Obj} */ x) => x.series)]) {
      for (const src of d.sourceRange.sources) bounds(book, src);
    }
    chart.chartId = chart.chartId ?? book.nextObjectId++;
    s.charts.push(chart);
  },
  deleteEmbeddedObject(book, r) {
    for (const s of book.sheets) {
      const i = s.charts.findIndex((/** @type {Obj} */ c) => c.chartId === r.objectId);
      if (i >= 0) { s.charts.splice(i, 1); return; }
    }
    throw new Error(`no embedded object ${r.objectId}`);
  },
  deleteDeveloperMetadata(book, r) {
    const id = r.dataFilter.developerMetadataLookup.metadataId;
    for (const s of book.sheets) s.metadata = s.metadata.filter((/** @type {Obj} */ m) => m.metadataId !== id);
  },
});

/** @param {Obj} book @param {Obj} request @param {number} i */
function apply(book, request, i) {
  const keys = Object.keys(request);
  if (keys.length !== 1 || !HANDLERS[keys[0]]) throw new Error(`requests[${i}]: unsupported request ${keys.join(",")}`);
  try { HANDLERS[keys[0]](book, request[keys[0]]); } catch (e) { throw new Error(`requests[${i}] (${keys[0]}): ${/** @type {Error} */ (e).message}`); }
}

/** @param {Obj} a @param {Obj} b */
function overlaps(a, b) {
  return a.r0 < b.r1 && b.r0 < a.r1 && a.c0 < b.c1 && b.c0 < a.c1;
}

/** Sheets index semantics: "before the move" indexes; no-op for current or current + 1. @param {Obj} book @param {Obj} s @param {number} index */
function moveSheet(book, s, index) {
  const from = book.sheets.indexOf(s);
  if (index === from || index === from + 1) return;
  book.sheets.splice(from, 1);
  book.sheets.splice(index > from ? index - 1 : index, 0, s);
}

/** @param {string} a1 */
function parseTarget(a1) {
  const m = /^'((?:[^']|'')*)'(?:!A(\d+))?$/.exec(a1);
  if (!m) throw new Error(`unsupported range ${a1}`);
  return { title: m[1].replace(/''/g, "'"), row: Number(m[2] ?? 1) - 1 };
}

/** @param {Obj} book @param {Obj} body */
function writeValues(book, body) {
  if (body.valueInputOption !== "USER_ENTERED") throw new Error("expected USER_ENTERED");
  for (const vr of body.data) {
    const { title, row } = parseTarget(vr.range);
    const s = book.sheets.find((/** @type {Obj} */ x) => x.title === title);
    if (!s) throw new Error(`Unable to parse range: ${vr.range}`);
    vr.values.forEach((/** @type {unknown[]} */ line, r) => {
      if (row + r >= s.rowCount) throw new Error("values beyond the grid");
      line.forEach((v, c) => {
        const key = `${row + r},${c}`;
        if (!s.cells.has(key)) s.cells.set(key, { format: {} });
        const cell = s.cells.get(key);
        if (v === "" || v == null) delete cell.value; else cell.value = v;
      });
    });
  }
  return {};
}

/** FORMATTED_VALUE reads: the stored value as text, trailing blanks trimmed. @param {Obj} book @param {string[]} ranges */
function readValues(book, ranges) {
  return {
    valueRanges: ranges.map((a1) => {
      const s = book.sheets.find((/** @type {Obj} */ x) => x.title === parseTarget(a1).title);
      const { rows, cols } = extent(s);
      const values = [];
      for (let r = 0; r < rows; r++) {
        const line = [];
        for (let c = 0; c < cols; c++) line.push(String(s.cells.get(`${r},${c}`)?.value ?? ""));
        while (line.length && line[line.length - 1] === "") line.pop();
        values.push(line);
      }
      return { range: a1, values };
    }),
  };
}

/** @param {Obj} s */
function extent(s) {
  let rows = 0, cols = 0;
  for (const [key, cell] of s.cells) {
    if (cell.value === undefined) continue;
    const [r, c] = key.split(",").map(Number);
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  return { rows, cols };
}

/** @param {Obj} book */
function metadata(book) {
  return {
    sheets: book.sheets.map((/** @type {Obj} */ s, index) => ({
      properties: {
        sheetId: s.sheetId, title: s.title, index, hidden: s.hidden,
        gridProperties: { rowCount: s.rowCount, columnCount: s.columnCount, frozenRowCount: s.frozenRows, frozenColumnCount: s.frozenColumns },
      },
      conditionalFormats: s.cf.map((/** @type {Obj} */ rule) => ({ ranges: rule.ranges.map((/** @type {Obj} */ r) => ({ sheetId: r.sheetId })) })),
      charts: s.charts.map((/** @type {Obj} */ c) => ({ chartId: c.chartId })),
      developerMetadata: s.metadata,
    })),
  };
}

/** Sheets Color → "#rrggbb". @param {Obj | undefined} style */
function hex(style) {
  const c = style?.rgbColor;
  if (!c) return undefined;
  const ch = (/** @type {number} */ v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${ch(c.red)}${ch(c.green)}${ch(c.blue)}`;
}

/** @param {Obj} r 0-based GridRange → [row, col, numRows, numCols] 1-based like getRange */
const rect = (r) => [r.startRowIndex + 1, r.startColumnIndex + 1, r.endRowIndex - r.startRowIndex, r.endColumnIndex - r.startColumnIndex];

const WRAP = /** @type {Record<string, string>} */ ({ WRAP: "WRAP", OVERFLOW_CELL: "OVERFLOW", CLIP: "CLIP" });

/** The normalized view shared with fake-apps-script.js. @param {Obj} book */
function snapshot(book) {
  return {
    order: book.sheets.map((/** @type {Obj} */ s) => s.title),
    sheets: Object.fromEntries(book.sheets.map((/** @type {Obj} */ s) => [s.title, {
      hidden: s.hidden,
      frozen: [s.frozenRows, s.frozenColumns],
      cells: Object.fromEntries([...s.cells].map(([key, cell]) => [key, cleanCell(cell)]).filter(([, v]) => Object.keys(v).length).sort(byKey)),
      merges: s.merges.map((/** @type {Obj} */ m) => `${m.r0},${m.c0}:${m.r1},${m.c1}`).sort(),
      rowHeights: Object.fromEntries([...s.rowHeights].filter(([, v]) => v !== 21).map(([k, v]) => [k, v])),
      colWidths: Object.fromEntries(s.colWidths),
      hiddenRows: [...s.hiddenRows].sort((a, b) => a - b),
      hiddenColumns: [...s.hiddenColumns].sort((a, b) => a - b),
      cf: s.cf.map(cleanRule),
      charts: s.charts.map(cleanChart),
    }])),
  };
}

/** @param {[string, unknown]} a @param {[string, unknown]} b */
function byKey(a, b) {
  const [ar, ac] = a[0].split(",").map(Number);
  const [br, bc] = b[0].split(",").map(Number);
  return ar - br || ac - bc;
}

/** @param {Obj} cell */
function cleanCell(cell) {
  const f = cell.format ?? {};
  const t = f.textFormat ?? {};
  /** @type {Obj} */
  const out = {};
  if (cell.value !== undefined) out.v = cell.value;
  if (f.numberFormat?.pattern) out.nf = f.numberFormat.pattern;
  if (t.bold) out.bold = true;
  if (t.italic) out.italic = true;
  if (t.fontSize) out.size = t.fontSize;
  if (hex(t.foregroundColorStyle)) out.color = hex(t.foregroundColorStyle);
  if (hex(f.backgroundColorStyle)) out.bg = hex(f.backgroundColorStyle);
  if (f.horizontalAlignment) out.align = f.horizontalAlignment.toLowerCase();
  if (f.wrapStrategy) out.wrap = WRAP[f.wrapStrategy];
  return out;
}

/** @param {Obj} p */
const point = (p) => ({ color: hex(p.colorStyle), type: p.type, ...(p.value != null ? { value: p.value } : {}) });

/** @param {Obj} rule */
function cleanRule(rule) {
  const ranges = rule.ranges.map(rect);
  if (rule.gradientRule) {
    const g = rule.gradientRule;
    return { ranges, gradient: { min: point(g.minpoint), mid: g.midpoint ? point(g.midpoint) : null, max: point(g.maxpoint) } };
  }
  const b = rule.booleanRule;
  const t = b.format.textFormat ?? {};
  return {
    ranges,
    when: { type: b.condition.type, value: b.condition.values?.[0]?.userEnteredValue },
    format: { bold: Boolean(t.bold), italic: Boolean(t.italic), strike: Boolean(t.strikethrough), color: hex(t.foregroundColorStyle), bg: hex(b.format.backgroundColorStyle) },
  };
}

/** @param {Obj} chart */
function cleanChart(chart) {
  const b = chart.spec.basicChart;
  const o = chart.position.overlayPosition;
  return {
    ranges: [b.domains[0].domain, ...b.series.map((/** @type {Obj} */ s) => s.series)].map((d) => rect(d.sourceRange.sources[0])),
    title: chart.spec.title ?? null,
    headers: b.headerCount,
    colors: b.series.map((/** @type {Obj} */ s) => hex(s.colorStyle) ?? null),
    anchor: [o.anchorCell.rowIndex + 1, o.anchorCell.columnIndex + 1],
    size: [o.widthPixels, o.heightPixels],
    showHidden: chart.spec.hiddenDimensionStrategy === "SHOW_ALL",
  };
}
