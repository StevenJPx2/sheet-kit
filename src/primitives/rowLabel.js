import { definePrimitive } from "../utils/define-primitive.js";

// rowLabel — style whole rows by matching a label column (section headers,
// cumulative rows, blank separators). Scans the label column so styling follows
// content, not hard-coded row numbers. match: {column,prefix,suffix,equals,empty};
// style: {bold,background,font_color,font_size,merge,row_height} (e.g. fold blank
// separators to row_height 8).
export default definePrimitive({
  name: "rowLabel",
  field: "row_label_styles",
  order: 50,
  validate(rules, columns) {
    for (const rule of rules ?? []) {
      const col = rule.match && rule.match.column;
      if (col != null && !columns.has(col)) return `row_label_style references unknown column ${JSON.stringify(col)}`;
    }
    return "";
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
