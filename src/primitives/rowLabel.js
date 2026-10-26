import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, matchLabel_ } from "../runtime/grid.js";
import { dimensionProps, formatCells, gridRange, mergeCells } from "../render/requests.js";

// rowLabel — style whole rows by matching a label column (section headers,
// cumulative rows, blank separators). Scans the label column so styling follows
// content, not hard-coded row numbers. match: {column,prefix,suffix,equals,empty};
// style: {bold,background,font_color,font_size,merge,row_height} (e.g. fold blank
// separators to row_height 8).
export default definePrimitive({
  name: "rowLabel",
  region: "format",
  inputs: function (ctx) {
    // Per rule: the match bitmap over the label column. Styling depends only on
    // WHICH rows match, never on the label text or any number.
    var values = ctx.values, columns = ctx.columns;
    var bits = (ctx.spec.row_label_styles || []).map(function (rule) {
      var name = rule.match && rule.match.column;
      var col = name ? columnIndex_(columns, name) : 1;
      if (col <= 0) col = 1;
      var s = "";
      for (var i = ctx.firstDataRow - 1; i < values.length; i++) s += matchLabel_(String(values[i][col - 1] || ""), rule.match) ? "1" : "0";
      return s;
    });
    return { rules: ctx.spec.row_label_styles || null, w: ctx.width, bits: bits };
  },
  field: "row_label_styles",
  order: 50,
  validate(rules, columns) {
    for (const rule of rules ?? []) {
      const col = rule.match && rule.match.column;
      if (col != null && !columns.has(col)) return `row_label_style references unknown column ${JSON.stringify(col)}`;
    }
    return "";
  },
  requests(ctx) {
    const out = [];
    for (const rule of ctx.spec.row_label_styles || []) {
      const name = rule.match && rule.match.column;
      let col = name ? columnIndex_(ctx.columns, name) : 1;
      if (col <= 0) col = 1;
      const s = rule.style || {};
      const height = s.row_height != null ? s.row_height : s.rowHeight;
      for (let i = ctx.firstDataRow - 1; i < ctx.values.length; i++) {
        if (!matchLabel_(String(ctx.values[i][col - 1] || ""), rule.match)) continue;
        const range = gridRange(ctx.sheetId, i + 1, 1, 1, ctx.width);
        if (s.merge) out.push(mergeCells(range));
        out.push(formatCells(range, {
          bold: s.bold, background: s.background,
          fontColor: s.font_color != null ? s.font_color : s.fontColor,
          fontSize: s.font_size != null ? s.font_size : s.fontSize,
        }));
        if (height) out.push(dimensionProps(ctx.sheetId, "ROWS", i + 1, 1, { pixelSize: height }));
      }
    }
    return out;
  },
  render: function (ctx) {
    var values = ctx.values, width = ctx.width, columns = ctx.columns;
    (ctx.spec.row_label_styles || []).forEach(function (rule) {
      var name = rule.match && rule.match.column;
      var col = name ? columnIndex_(columns, name) : 1;
      if (col <= 0) col = 1;

      for (var i = ctx.firstDataRow - 1; i < values.length; i++) {
        var label = String(values[i][col - 1] || "");
        if (!matchLabel_(label, rule.match)) continue;

        var r = i + 1;
        var s = rule.style || {};
        var height = s.row_height != null ? s.row_height : s.rowHeight;
        var fontColor = s.font_color != null ? s.font_color : s.fontColor;
        var fontSize = s.font_size != null ? s.font_size : s.fontSize;
        var target = s.merge ? ctx.sheet.getRange(r, 1, 1, width).merge() : ctx.sheet.getRange(r, 1, 1, width);

        if (s.bold) target.setFontWeight("bold");
        if (s.background) target.setBackground(s.background);
        if (fontColor) target.setFontColor(fontColor);
        if (fontSize) target.setFontSize(fontSize);
        if (height) ctx.sheet.setRowHeight(r, height);
      }
    });
  },
});
