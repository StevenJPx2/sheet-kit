import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, compareFormula_ } from "../runtime/grid.js";
import { colorStyle, gridRange } from "../render/requests.js";

// compareStyle — per row, style whichever of two columns holds the larger number.
// Cells may be formatted strings ("$3.46", "3.55%", "27,370"): the rule strips
// everything but digits/./- before comparing, and skips rows where either side
// isn't numeric (labels, blanks). Conditional-format based, so it stays right on
// re-render. style: { bold, italic, underline, strikethrough, font_color,
// background } — defaults to { bold: true }. The condition formula comes from
// compareFormula_ (runtime/grid.js), shared with the Sheets API renderer.
const STYLE_KEYS = new Set(["bold", "italic", "underline", "strikethrough", "font_color", "background"]);

export default definePrimitive({
  name: "compareStyle",
  region: "cf",
  inputs: function (ctx) { return { c: ctx.spec.compare_style || null, r: ctx.firstDataRow, n: ctx.dataRowCount }; },
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
  render: function (ctx) {
    (ctx.spec.compare_style || []).forEach(function (p) {
      var a = columnIndex_(ctx.columns, p.a);
      var b = columnIndex_(ctx.columns, p.b);
      if (a <= 0 || b <= 0 || ctx.dataRowCount <= 0) return;
      var style = p.style || { bold: true };
      [[a, b], [b, a]].forEach(function (pair) {
        var range = ctx.sheet.getRange(ctx.firstDataRow, pair[0], ctx.dataRowCount, 1);
        var rule = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(compareFormula_(pair[0], pair[1], ctx.firstDataRow));
        if (style.bold) rule.setBold(true);
        if (style.italic) rule.setItalic(true);
        if (style.underline) rule.setUnderline(true);
        if (style.strikethrough) rule.setStrikethrough(true);
        if (style.font_color) rule.setFontColor(style.font_color);
        if (style.background) rule.setBackground(style.background);
        ctx.cfRules.push(rule.setRanges([range]).build());
      });
    });
  },
});
