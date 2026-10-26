// Sheets API v4 request builders. Public row/column arguments are 1-based;
// GridRanges in emitted requests are 0-based and end-exclusive.

/**
 * @typedef {{ sheetId: number, startRowIndex?: number, endRowIndex?: number, startColumnIndex?: number, endColumnIndex?: number }} GridRange
 * @typedef {{ red: number, green: number, blue: number }} Color
 * @typedef {Record<string, any>} Request  one batchUpdate Request object
 */

/**
 * @param {number} sheetId
 * @param {number} row 1-based
 * @param {number} col 1-based
 * @param {number} numRows
 * @param {number} numCols
 * @returns {GridRange}
 */
export function gridRange(sheetId, row, col, numRows, numCols) {
  return { sheetId, startRowIndex: row - 1, endRowIndex: row - 1 + numRows, startColumnIndex: col - 1, endColumnIndex: col - 1 + numCols };
}

const NAMED = /** @type {Record<string, string>} */ ({
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", gray: "#808080", grey: "#808080", orange: "#ffa500",
});

/**
 * "#rgb" / "#rrggbb" (or a basic CSS name) → Sheets Color in [0, 1].
 * @param {string} css
 * @returns {Color}
 */
export function rgb(css) {
  const raw = String(css).trim().toLowerCase();
  let hex = (NAMED[raw] ?? raw).replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(hex)) hex = hex.replace(/./g, "$&$&");
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error(`unsupported color ${JSON.stringify(css)} (use #rrggbb)`);
  const ch = (/** @type {number} */ i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1e6) / 1e6;
  return { red: ch(0), green: ch(2), blue: ch(4) };
}

/** @param {string} css */
export function colorStyle(css) {
  return { rgbColor: rgb(css) };
}

/**
 * The NumberFormat for a Sheets pattern; the API requires a type next to the
 * pattern, so infer it from the pattern's tokens.
 * @param {string} pattern
 */
export function numberFormat(pattern) {
  const p = String(pattern);
  const bare = p.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  let type = "NUMBER";
  if (p === "@") type = "TEXT";
  else if (/[yd]/i.test(bare) && /[hs]/i.test(bare)) type = "DATE_TIME";
  else if (/[yd]/i.test(bare) || /^m+([^0#]|$)/i.test(bare)) type = "DATE";
  else if (/h|s{1,2}\b|am\/pm/i.test(bare)) type = "TIME";
  else if (/%/.test(bare)) type = "PERCENT";
  else if (/[$€£¥]/.test(p)) type = "CURRENCY";
  else if (/e[+-]/i.test(bare)) type = "SCIENTIFIC";
  return { type, pattern: p };
}

/**
 * @typedef {Object} Style  cell format properties
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {string}  [background]
 * @property {string}  [fontColor]
 * @property {number}  [fontSize]
 * @property {string}  [align]         left | center | right
 * @property {boolean} [wrap]          true = WRAP, false = OVERFLOW (Range.setWrap)
 * @property {string}  [numberFormat]
 */

/**
 * One repeatCell that applies `style` to `range`, touching only the fields it
 * sets. Null when empty.
 * @param {GridRange} range
 * @param {Style} style
 * @returns {Request | null}
 */
export function formatCells(range, style) {
  /** @type {Record<string, any>} */
  const format = {};
  /** @type {Record<string, any>} */
  const text = {};
  const fields = [];
  if (style.bold) { text.bold = true; fields.push("textFormat.bold"); }
  if (style.italic) { text.italic = true; fields.push("textFormat.italic"); }
  if (style.fontColor) { text.foregroundColorStyle = colorStyle(style.fontColor); fields.push("textFormat.foregroundColorStyle"); }
  if (style.fontSize) { text.fontSize = style.fontSize; fields.push("textFormat.fontSize"); }
  if (fields.length) format.textFormat = text;
  if (style.background) { format.backgroundColorStyle = colorStyle(style.background); fields.push("backgroundColorStyle"); }
  if (style.align) { format.horizontalAlignment = String(style.align).toUpperCase(); fields.push("horizontalAlignment"); }
  if (style.wrap != null) { format.wrapStrategy = style.wrap ? "WRAP" : "OVERFLOW_CELL"; fields.push("wrapStrategy"); }
  if (style.numberFormat) { format.numberFormat = numberFormat(style.numberFormat); fields.push("numberFormat"); }
  if (!fields.length) return null;
  return { repeatCell: { range, cell: { userEnteredFormat: format }, fields: fields.map((f) => `userEnteredFormat.${f}`).join(",") } };
}

/** @param {GridRange} range @returns {Request} */
export function mergeCells(range) {
  return { mergeCells: { range, mergeType: "MERGE_ALL" } };
}

/**
 * @param {number} sheetId
 * @param {"ROWS" | "COLUMNS"} dimension
 * @param {number} start 1-based
 * @param {number} count
 * @param {Record<string, unknown>} properties  e.g. { pixelSize: 21 } or { hiddenByUser: true }
 * @returns {Request}
 */
export function dimensionProps(sheetId, dimension, start, count, properties) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension, startIndex: start - 1, endIndex: start - 1 + count },
      properties,
      fields: Object.keys(properties).join(","),
    },
  };
}

/** sheet.autoResizeRows(row, count). @param {number} sheetId @param {number} row @param {number} count @returns {Request} */
export function autoResizeRows(sheetId, row, count) {
  return { autoResizeDimensions: { dimensions: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row - 1 + count } } };
}

/**
 * @param {number} sheetId
 * @param {Record<string, number>} grid  gridProperties to set
 * @returns {Request}
 */
export function gridProps(sheetId, grid) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: grid },
      fields: Object.keys(grid).map((k) => `gridProperties.${k}`).join(","),
    },
  };
}
