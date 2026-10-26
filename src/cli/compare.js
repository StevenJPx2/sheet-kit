// Read-only comparison of the public inspect shape. Resource ids and workbook
// titles differ between copies and are deliberately ignored. Tab order, locale,
// timezone, tab structure and every inspected cell field are compared.
import { isDeepStrictEqual } from "node:util";
import { columnLetters, inspectViaSheetsApi } from "./inspect.js";

const CELL_FIELDS = ["values", "formulas", "number_formats", "backgrounds", "font_weights", "horizontal_alignments", "wrap_strategies"];
const TAB_FIELDS = ["hidden", "rows", "columns", "frozen_rows", "frozen_columns", "merges", "conditional_formats"];

/**
 * @typedef {{ sheet?: string, cell?: string, field: string, left: unknown, right: unknown }} Difference
 */

/**
 * Compare two inspect outputs with cells included (starting at A1).
 * @param {{ locale: string, timezone: string, sheets: Record<string, any>[] }} left
 * @param {{ locale: string, timezone: string, sheets: Record<string, any>[] }} right
 */
export function compareSnapshots(left, right) {
  /** @type {Difference[]} */
  const differences = [];
  /** @param {string} field @param {unknown} a @param {unknown} b @param {string} [sheet] @param {string} [cell] */
  const diff = (field, a, b, sheet, cell) => {
    if (!isDeepStrictEqual(a, b)) differences.push({ ...(sheet ? { sheet } : {}), ...(cell ? { cell } : {}), field, left: a, right: b });
  };
  for (const field of /** @type {const} */ (["locale", "timezone"])) diff(field, left[field], right[field]);
  const a = new Map(left.sheets.map((s) => [s.name, s]));
  const b = new Map(right.sheets.map((s) => [s.name, s]));
  diff("tab_order", [...a.keys()], [...b.keys()]);
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name), y = b.get(name);
    if (!x || !y) { diff("present", Boolean(x), Boolean(y), name); continue; }
    for (const field of TAB_FIELDS) diff(field, x[field], y[field], name);
    for (const field of CELL_FIELDS) {
      const xs = x[field] ?? [], ys = y[field] ?? [];
      for (let r = 0; r < Math.max(xs.length, ys.length); r++) {
        for (let c = 0; c < Math.max(xs[r]?.length ?? 0, ys[r]?.length ?? 0); c++) {
          diff(field, xs[r]?.[c] ?? null, ys[r]?.[c] ?? null, name, `${columnLetters(c)}${r + 1}`);
        }
      }
    }
  }
  return { identical: differences.length === 0, differences };
}

/**
 * @param {string} token
 * @param {{ spreadsheetId: string, against: string, sheet?: string }} opts
 * @param {typeof fetch} [fetchImpl]
 */
export async function compareViaSheetsApi(token, opts, fetchImpl = fetch) {
  const [left, right] = await Promise.all([
    inspectViaSheetsApi(token, { spreadsheetId: opts.spreadsheetId, sheet: opts.sheet, cells: true }, fetchImpl),
    inspectViaSheetsApi(token, { spreadsheetId: opts.against, sheet: opts.sheet, cells: true }, fetchImpl),
  ]);
  return compareSnapshots(left, right);
}
