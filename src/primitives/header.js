import { definePrimitive } from "../utils/define-primitive.js";

// header — header-row emphasis. Always runs: bolds + left-aligns the header
// block, merges grouped-header spans (2-row headers, group labels on row 1),
// and bolds any column flagged bold.
export default definePrimitive({
  name: "header",
  field: null,
  order: 10,
  validate(tab, columns) {
    for (const m of tab.header_merges ?? []) {
      if (!columns.has(m.from) || !columns.has(m.to)) {
        return `header_merge references unknown column ${JSON.stringify(m.from)}/${JSON.stringify(m.to)}`;
      }
    }
    return "";
  },
  render: function (ctx) {
    var sheet = ctx.sheet, columns = ctx.columns, width = ctx.width;

    sheet.getRange(1, 1, ctx.headerRows, width).setFontWeight("bold").setHorizontalAlignment("left");

    if (ctx.dataRowCount > 0) {
      columns.forEach(function (c, ci) {
        if (c.bold) sheet.getRange(ctx.firstDataRow, ci + 1, ctx.dataRowCount, 1).setFontWeight("bold");
      });
    }

    (ctx.spec.header_merges || []).forEach(function (m) {
      var from = columnIndex_(columns, m.from);
      var to = columnIndex_(columns, m.to);
      if (from > 0 && to > from) sheet.getRange(1, from, 1, to - from + 1).merge();
    });
  },
});
