// Inspect through spreadsheets.get with a field mask. Map API properties and
// sparse cell blocks to a tab-oriented snapshot, with explicit cell defaults.
import { googleJson } from "../google/http.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const DEFAULT_NUMBER_FORMAT = "0.###############";
/** @type {Record<string, string>} */
const WRAP = { OVERFLOW_CELL: "OVERFLOW", LEGACY_WRAP: "WRAP", WRAP: "WRAP", CLIP: "CLIP" };

/**
 * @typedef {{ spreadsheetId: string, sheet?: string, range?: string, cells?: boolean }} InspectOptions
 * @typedef {{ startRowIndex?: number, endRowIndex?: number, startColumnIndex?: number, endColumnIndex?: number }} GridRange
 * @typedef {{ r0: number, r1: number, c0: number, c1: number, form?: "columns" | "rows" }} Bounds  0-based, end-exclusive
 * @typedef {{ startRow?: number, startColumn?: number, rowData?: { values?: any[] }[] }} GridData
 */

/** @param {boolean} cells */
export function fieldMask(cells) {
  const cell = cells
    ? "userEnteredValue,formattedValue,userEnteredFormat(numberFormat,backgroundColor,backgroundColorStyle,textFormat(bold),horizontalAlignment,wrapStrategy)"
    : "userEnteredValue";
  return "spreadsheetId,properties(title,locale,timeZone),"
    + "sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),"
    + `merges,conditionalFormats(ranges,gradientRule),data(startRow,startColumn,rowData(values(${cell}))))`;
}

/**
 * @param {string} token
 * @param {InspectOptions} opts
 * @param {typeof fetch} [fetchImpl]
 */
export async function inspectViaSheetsApi(token, opts, fetchImpl = fetch) {
  const params = new URLSearchParams({ fields: fieldMask(Boolean(opts.cells)) });
  if (opts.sheet) params.append("ranges", `'${opts.sheet.replace(/'/g, "''")}'`);
  const url = `${API}/${encodeURIComponent(opts.spreadsheetId)}?${params}`;
  try {
    return mapSpreadsheet(await googleJson(token, "GET", url, undefined, { fetchImpl }), opts);
  } catch (error) {
    if (opts.sheet && /Unable to parse range/i.test(String(error))) throw new Error(`sheet not found: ${opts.sheet}`);
    throw error;
  }
}

/**
 * Map a spreadsheets.get response to the public inspect output.
 * @param {any} resp
 * @param {Omit<InspectOptions, "spreadsheetId">} opts
 */
export function mapSpreadsheet(resp, opts) {
  const sheets = (resp.sheets ?? [])
    .filter((/** @type {any} */ s) => !opts.sheet || s.properties?.title === opts.sheet)
    .map((/** @type {any} */ s) => mapSheet(s, opts));
  if (opts.sheet && sheets.length === 0) throw new Error(`sheet not found: ${opts.sheet}`);
  return {
    id: resp.spreadsheetId,
    name: resp.properties?.title ?? "",
    locale: resp.properties?.locale ?? "",
    timezone: resp.properties?.timeZone ?? "",
    sheets,
  };
}

/**
 * @param {any} sheet
 * @param {Omit<InspectOptions, "spreadsheetId">} opts
 */
function mapSheet(sheet, opts) {
  const p = sheet.properties ?? {};
  const grid = p.gridProperties ?? {};
  /** @type {GridData} */
  const data = sheet.data?.[0] ?? {};
  const extent = contentExtent(data);
  // getDataRange(): A1 through the last row/column with content, or A1 alone.
  const dataRange = { r0: 0, r1: Math.max(extent.rows, 1), c0: 0, c1: Math.max(extent.cols, 1) };

  /** @type {Record<string, unknown>} */
  const result = {
    name: p.title ?? "",
    id: p.sheetId ?? 0,
    hidden: Boolean(p.hidden),
    rows: extent.rows,
    columns: extent.cols,
    frozen_rows: grid.frozenRowCount ?? 0,
    frozen_columns: grid.frozenColumnCount ?? 0,
    merges: (sheet.merges ?? []).map(toBounds).filter((/** @type {Bounds} */ b) => intersects(b, dataRange)).map(a1),
    conditional_formats: (sheet.conditionalFormats ?? []).map((/** @type {any} */ rule) => ({
      ranges: (rule.ranges ?? []).map((/** @type {GridRange} */ r) => a1(toBounds(r))),
      type: rule.gradientRule ? "gradient" : "boolean",
    })),
  };
  if (!opts.cells) return result;

  const bounds = opts.range ? parseA1(opts.range, grid.rowCount ?? extent.rows, grid.columnCount ?? extent.cols) : dataRange;
  const fmt = (/** @type {any} */ c) => c.userEnteredFormat ?? {};
  result.range = a1(bounds);
  result.values = block(data, bounds, (c) => c.formattedValue ?? "");
  result.formulas = block(data, bounds, (c) => c.userEnteredValue?.formulaValue ?? "");
  result.number_formats = block(data, bounds, (c) => fmt(c).numberFormat?.pattern || DEFAULT_NUMBER_FORMAT);
  result.backgrounds = block(data, bounds, (c) => toHex(fmt(c).backgroundColorStyle?.rgbColor ?? fmt(c).backgroundColor));
  result.font_weights = block(data, bounds, (c) => (fmt(c).textFormat?.bold ? "bold" : "normal"));
  result.horizontal_alignments = block(data, bounds, (c) => String(fmt(c).horizontalAlignment ?? "general").toLowerCase());
  result.wrap_strategies = block(data, bounds, (c) => WRAP[fmt(c).wrapStrategy] ?? "OVERFLOW");
  return result;
}

/**
 * Last row/column holding a value or formula (getLastRow / getLastColumn).
 * @param {GridData} data
 */
function contentExtent(data) {
  let rows = 0;
  let cols = 0;
  (data.rowData ?? []).forEach((row, r) => {
    (row.values ?? []).forEach((cell, c) => {
      if (cell?.userEnteredValue === undefined) return;
      rows = Math.max(rows, (data.startRow ?? 0) + r + 1);
      cols = Math.max(cols, (data.startColumn ?? 0) + c + 1);
    });
  });
  return { rows, cols };
}

/**
 * @param {GridData} data
 * @param {Bounds} b
 * @param {(cell: any) => string} pick
 * @returns {string[][]}
 */
function block(data, b, pick) {
  const out = [];
  for (let r = b.r0; r < b.r1; r++) {
    const row = data.rowData?.[r - (data.startRow ?? 0)]?.values ?? [];
    const line = [];
    for (let c = b.c0; c < b.c1; c++) line.push(pick(row[c - (data.startColumn ?? 0)] ?? {}));
    out.push(line);
  }
  return out;
}

/** @param {GridRange} r @returns {Bounds} */
function toBounds(r) {
  const rowsOpen = r.startRowIndex === undefined && r.endRowIndex === undefined;
  const colsOpen = r.startColumnIndex === undefined && r.endColumnIndex === undefined;
  return {
    r0: r.startRowIndex ?? 0,
    r1: r.endRowIndex ?? Infinity,
    c0: r.startColumnIndex ?? 0,
    c1: r.endColumnIndex ?? Infinity,
    form: rowsOpen ? "columns" : colsOpen ? "rows" : undefined,
  };
}

/** @param {Bounds} a @param {Bounds} b */
function intersects(a, b) {
  return a.r0 < b.r1 && b.r0 < a.r1 && a.c0 < b.c1 && b.c0 < a.c1;
}

/** @param {number} index 0-based */
export function columnLetters(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** @param {string} letters */
function columnIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A1 notation as Range.getA1Notation() prints it. @param {Bounds} b */
export function a1(b) {
  if (b.form === "columns") return `${columnLetters(b.c0)}:${columnLetters(b.c1 - 1)}`;
  if (b.form === "rows") return `${b.r0 + 1}:${b.r1}`;
  const start = `${columnLetters(b.c0)}${b.r0 + 1}`;
  const end = `${columnLetters(b.c1 - 1)}${b.r1}`;
  return start === end ? start : `${start}:${end}`;
}

/**
 * Parse A1 (A1, A1:C9, A:C, 2:5; an optional Sheet! prefix is ignored).
 * Open column/row ranges extend to the sheet's grid size, as getRange does.
 * @param {string} range
 * @param {number} gridRows
 * @param {number} gridCols
 * @returns {Bounds}
 */
export function parseA1(range, gridRows, gridCols) {
  const ref = range.includes("!") ? range.slice(range.lastIndexOf("!") + 1) : range;
  const [from, to = from] = ref.replace(/\$/g, "").split(":");
  const cell = /^([A-Za-z]*)(\d*)$/;
  const a = cell.exec(from);
  const b = cell.exec(to);
  if (!a || !b || (!a[1] && !a[2]) || (!b[1] && !b[2])) throw new Error(`invalid A1 range: ${range}`);
  const form = !a[2] && !b[2] ? "columns" : !a[1] && !b[1] ? "rows" : undefined;
  /** @type {Bounds} */
  const bounds = {
    r0: a[2] ? Number(a[2]) - 1 : 0,
    r1: b[2] ? Number(b[2]) : gridRows,
    c0: a[1] ? columnIndex(a[1]) : 0,
    c1: b[1] ? columnIndex(b[1]) + 1 : gridCols,
    form,
  };
  if (Boolean(a[1]) !== Boolean(b[1]) || Boolean(a[2]) !== Boolean(b[2])
    || bounds.r0 < 0 || bounds.c0 < 0 || bounds.r1 <= bounds.r0 || bounds.c1 <= bounds.c0
    || bounds.r1 > gridRows || bounds.c1 > gridCols) throw new Error(`invalid A1 range: ${range}`);
  return bounds;
}

/** Sheets API Color → "#rrggbb"; absent means the default white. @param {any} rgb */
function toHex(rgb) {
  if (!rgb) return "#ffffff";
  const ch = (/** @type {number | undefined} */ v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${ch(rgb.red)}${ch(rgb.green)}${ch(rgb.blue)}`;
}
