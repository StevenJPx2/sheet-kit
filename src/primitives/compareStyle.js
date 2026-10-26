import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, compareFormula_ } from "../render/grid.js";
import { colorStyle, gridRange } from "../render/requests.js";

// compareStyle — per row, style whichever of two columns holds the larger number.
// Cells may be formatted strings ("$3.46", "3.55%", "27,370"): the rule strips
// everything but digits/./- before comparing, and skips rows where either side
// isn't numeric (labels, blanks). Conditional-format based, so it stays right on
// re-render. style: { bold, italic, underline, strikethrough, font_color,
// background } — defaults to { bold: true }. The condition formula comes from
// compareFormula_ (render/grid.js).
const STYLE_KEYS = new Set(["bold", "italic", "underline", "strikethrough", "font_color", "background"]);

export default definePrimitive({
  name: "compareStyle",
  field: "compare_style",
  order: 41,
  validate(pairs, columns) {
    for (const p of pairs ?? []) {
      for (const k of ["a", "b"]) {
        if (!columns.has(p[k])) return `compare_style references unknown column ${JSON.stringify(p[k])}`;
      }
      for (const k of Object.keys(p.style ?? {})) {
        if (!STYLE_KEYS.has(k)) return `compare_style: unknown style key ${JSON.stringify(k)}`;
      }
    }
    return "";
  },
  requests(ctx) {
    for (const p of ctx.spec.compare_style || []) {
      const a = columnIndex_(ctx.columns, p.a);
      const b = columnIndex_(ctx.columns, p.b);
      if (a <= 0 || b <= 0 || ctx.dataRowCount <= 0) continue;
      const style = p.style || { bold: true };
      // The API's conditional formats support bold, italic, strikethrough and
      // colours only (BooleanRule.format); underline is dropped, not failed on.
      if (style.underline) ctx.warnings.push("compare_style underline is not supported by the Sheets API; ignored");
      /** @type {Record<string, any>} */
      const text = {};
      if (style.bold) text.bold = true;
      if (style.italic) text.italic = true;
      if (style.strikethrough) text.strikethrough = true;
      if (style.font_color) text.foregroundColorStyle = colorStyle(style.font_color);
      const format = {
        ...(Object.keys(text).length ? { textFormat: text } : {}),
        ...(style.background ? { backgroundColorStyle: colorStyle(style.background) } : {}),
      };
      for (const [self, other] of [[a, b], [b, a]]) {
        ctx.cfRules.push({
          ranges: [gridRange(ctx.sheetId, ctx.firstDataRow, self, ctx.dataRowCount, 1)],
          booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: compareFormula_(self, other, ctx.firstDataRow) }] }, format },
        });
      }
    }
    return [];
  },
});
