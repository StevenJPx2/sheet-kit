// The Sheets API renderer: renders a manifest + data straight into the
// manifest's spreadsheet, producing what the Apps Script renderTab produces in
// full mode, in a fixed number of calls for the whole spreadsheet:
//
//   1. spreadsheets.get           sheet ids, grid sizes, frozen counts, rule/chart/metadata ids
//   2. values.batchGet            (only tabs with preserve columns) the current cells
//   3. batchUpdate  "reset"       add missing tabs; unmerge, unfreeze, clear values+formats,
//                                 row heights 21, drop conditional formats; text-format string columns
//   4. values.batchUpdate         every tab's grid, USER_ENTERED (parsed like setValues)
//   5. batchUpdate  "style"       each used primitive's requests(ctx), then the cf rules in order
//
// The reset must precede the values (string columns are text-formatted first so
// "$2.38" isn't parsed into 2.38) and the style must follow them (auto-resized
// rows measure the written text), hence two batchUpdates. Writes over ~1.5 MB
// are split into several calls.
import { buildGrid_, normalizeWidth_, preserveValues_ } from "../runtime/grid.js";
import { usedPrimitives } from "../utils/compiler.js";
import { quoteSheet, sheetsClient } from "../google/sheets.js";
import { dimensionProps, formatCells, gridProps, gridRange } from "./requests.js";

/** The Apps Script renderer's incremental-render state key (core.js SK_STATE_KEY). */
const LEGACY_STATE_KEY = "sk_layout";
const NEW_SHEET_ROWS = 1000;
const NEW_SHEET_COLUMNS = 26;
const DEFAULT_ROW_HEIGHT = 21;

export const META_FIELDS =
  "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))," +
  "conditionalFormats(ranges(sheetId)),charts(chartId),developerMetadata(metadataId,metadataKey))";

/**
 * @typedef {Object} SheetState  what render needs to know about an existing tab
 * @property {number}   sheetId
 * @property {string}   title
 * @property {boolean}  hidden
 * @property {number}   rowCount
 * @property {number}   columnCount
 * @property {number}   frozenRows
 * @property {number}   frozenColumns
 * @property {number}   cfCount
 * @property {number[]} chartIds
 * @property {number[]} legacyStateIds  developer metadata ids of the Apps Script render state
 *
 * @typedef {import("../render/requests.js").Request} Request
 * @typedef {import("../google/sheets.js").ValueRange} ValueRange
 * @typedef {{ reset: Request[], values: ValueRange[], style: Request[], tabs: { sheet: string, rows: number, mode: "full" }[], warnings: string[] }} RenderPlan
 */

/**
 * @param {any} meta  spreadsheets.get response for META_FIELDS
 * @returns {Map<string, SheetState>}
 */
export function sheetStates(meta) {
  const states = new Map();
  for (const s of meta.sheets ?? []) {
    const p = s.properties ?? {};
    const g = p.gridProperties ?? {};
    states.set(p.title, {
      sheetId: p.sheetId ?? 0,
      title: p.title,
      hidden: Boolean(p.hidden),
      rowCount: g.rowCount ?? 0,
      columnCount: g.columnCount ?? 0,
      frozenRows: g.frozenRowCount ?? 0,
      frozenColumns: g.frozenColumnCount ?? 0,
      cfCount: (s.conditionalFormats ?? []).length,
      chartIds: (s.charts ?? []).map((/** @type {any} */ c) => c.chartId),
      legacyStateIds: (s.developerMetadata ?? [])
        .filter((/** @type {any} */ m) => m.metadataKey === LEGACY_STATE_KEY)
        .map((/** @type {any} */ m) => m.metadataId),
    });
  }
  return states;
}

/**
 * A sheet id for a new tab: derived from its title (stable for fixtures and
 * re-runs), bumped past ids already in use.
 * @param {string} title
 * @param {Set<number>} taken
 */
export function newSheetId(title, taken) {
  let h = 0x811c9dc5;
  for (let i = 0; i < title.length; i++) h = Math.imul(h ^ title.charCodeAt(i), 0x01000193) >>> 0;
  let id = (h % 2_000_000_000) + 1;
  while (taken.has(id)) id++;
  taken.add(id);
  return id;
}

/** The manifest tabs whose old cells must be read to keep their preserve columns. @param {any[]} tabs */
export function tabsNeedingOldValues(tabs) {
  return tabs.filter((t) => t.row_key && (t.columns || []).some((/** @type {any} */ c) => c.preserve));
}

/**
 * Plan a full render of every tab that has a dataset. Pure: no I/O.
 * @param {import("../types.js").Manifest} manifest
 * @param {import("../types.js").Data} data
 * @param {Map<string, SheetState>} states
 * @param {Map<string, unknown[][]>} [oldGrids]  current cells (formatted) of preserve tabs, by title
 * @returns {RenderPlan}
 */
export function planRender(manifest, data, states, oldGrids = new Map()) {
  const tabs = manifest.tabs.filter((t) => Object.prototype.hasOwnProperty.call(data.datasets ?? {}, t.data_key));
  const used = usedPrimitives(manifest.tabs);
  const taken = new Set([...states.values()].map((s) => s.sheetId));
  /** @type {RenderPlan} */
  const plan = { reset: [], values: [], style: [], tabs: [], warnings: [] };
  // renderTab runs tab by tab, so a tab's "last" is last among the tabs that
  // exist at its turn; a new tab rendered later still lands after it.
  let sheetCount = states.size;

  for (const spec of tabs) {
    const state = states.get(spec.name) ?? null;
    if (!state) sheetCount++;
    const sheetId = state ? state.sheetId : newSheetId(spec.name, taken);
    const tab = planTab(spec, data.datasets[spec.data_key] ?? [], { state, sheetId, sheetCount, used, oldGrid: oldGrids.get(spec.name) });
    plan.reset.push(...tab.reset);
    if (tab.values) plan.values.push(tab.values);
    plan.style.push(...tab.style);
    plan.warnings.push(...tab.warnings.map((w) => `${spec.name}: ${w}`));
    plan.tabs.push({ sheet: spec.name, rows: tab.rows, mode: "full" });
  }
  plan.warnings = [...new Set(plan.warnings)];
  return plan;
}

/**
 * @param {import("../types.js").Tab} spec
 * @param {import("../types.js").Row[]} rows
 * @param {{ state: SheetState | null, sheetId: number, sheetCount: number, used: import("../utils/define-primitive.js").Primitive[], oldGrid?: unknown[][] }} o
 */
function planTab(spec, rows, { state, sheetId, sheetCount, used, oldGrid }) {
  const built = buildGrid_(spec, rows);
  let values = normalizeWidth_(built.values);
  if (oldGrid) values = normalizeWidth_(preserveValues_(spec, oldGrid, values));
  const headerRows = spec.header_row || 1;
  const width = values.length ? values[0].length : 1;
  const gridRows = state ? Math.max(state.rowCount, values.length, 1) : Math.max(NEW_SHEET_ROWS, values.length);
  const gridColumns = state ? Math.max(state.columnCount, width) : Math.max(NEW_SHEET_COLUMNS, width);

  /** @type {import("../utils/define-primitive.js").ApiCtx} */
  const ctx = {
    sheetId, spec, columns: spec.columns || [], values, width,
    rows: values.length, headerRows, firstDataRow: headerRows + 1,
    dataRowCount: Math.max(0, values.length - headerRows),
    sections: built.sections, headers: built.headers,
    sheet: { gridRows, gridColumns, chartIds: state?.chartIds ?? [], hidden: state?.hidden ?? false, sheetCount },
    cfRules: [], warnings: [],
  };

  const reset = resetRequests(spec, state, ctx);
  /** @type {Request[]} */
  let style = [];
  if (values.length) {
    style = used.flatMap((p) => p.requests(ctx)).filter(Boolean);
    style.push(...ctx.cfRules.map((rule, index) => ({ addConditionalFormatRule: { rule, index } })));
  }
  const valueRange = values.length
    ? /** @type {ValueRange} */ ({ range: `${quoteSheet(spec.name)}!A1`, majorDimension: "ROWS", values })
    : null;
  return { reset, values: valueRange, style, rows: values.length, warnings: ctx.warnings };
}

/**
 * skWriteTable_ as requests: a fresh tab, or an existing one wiped back to
 * values-free, format-free, unmerged, unfrozen, 21px rows and no conditional
 * formats. String columns are then text-formatted so their display text
 * survives the USER_ENTERED write.
 * @param {import("../types.js").Tab} spec
 * @param {SheetState | null} state
 * @param {import("../utils/define-primitive.js").ApiCtx} ctx
 * @returns {Request[]}
 */
function resetRequests(spec, state, ctx) {
  const { sheetId } = ctx;
  const { gridRows, gridColumns } = ctx.sheet;
  /** @type {Request[]} */
  const out = [];
  if (!state) {
    out.push({ addSheet: { properties: { sheetId, title: spec.name, gridProperties: { rowCount: gridRows, columnCount: gridColumns } } } });
  } else {
    if (gridRows > state.rowCount || gridColumns > state.columnCount) out.push(gridProps(sheetId, { rowCount: gridRows, columnCount: gridColumns }));
    out.push({ unmergeCells: { range: { sheetId } } });
    // A frozen column would block this render's full-width heading merges.
    if (state.frozenRows || state.frozenColumns) out.push(gridProps(sheetId, { frozenRowCount: 0, frozenColumnCount: 0 }));
    out.push({ updateCells: { range: { sheetId }, fields: "userEnteredValue,userEnteredFormat" } });
    out.push(dimensionProps(sheetId, "ROWS", 1, gridRows, { pixelSize: DEFAULT_ROW_HEIGHT }));
    for (let i = state.cfCount - 1; i >= 0; i--) out.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    // A later webhook publish must not trust the Apps Script renderer's old
    // incremental state: without it, it does a full render.
    for (const metadataId of state.legacyStateIds) out.push({ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId } } } });
  }
  ctx.columns.forEach((c, i) => {
    if (c && c.type === "string" && i < ctx.width) {
      out.push(/** @type {Request} */ (formatCells(gridRange(sheetId, 1, i + 1, Math.max(ctx.rows, 1), 1), { numberFormat: "@" })));
    }
  });
  return out;
}

/**
 * Render a manifest + data into manifest.spreadsheet_id through the Sheets API.
 * @param {import("../types.js").Manifest} manifest
 * @param {import("../types.js").Data} data
 * @param {{ token: string, deps?: import("../google/http.js").HttpDeps }} o
 */
export async function renderManifest(manifest, data, { token, deps }) {
  const client = sheetsClient(manifest.spreadsheet_id, token, deps);
  const states = sheetStates(await client.get(META_FIELDS));

  const preserve = tabsNeedingOldValues(manifest.tabs).filter((t) => states.has(t.name));
  const grids = await client.readValues(preserve.map((t) => quoteSheet(t.name)), "FORMATTED_VALUE");
  const oldGrids = new Map(preserve.map((t, i) => [t.name, grids[i] ?? []]));

  const plan = planRender(manifest, data, states, oldGrids);
  await client.batchUpdate(plan.reset);
  await client.writeValues(plan.values);
  await client.batchUpdate(plan.style);
  return { tabs: plan.tabs, warnings: plan.warnings, calls: client.calls };
}
