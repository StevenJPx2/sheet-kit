import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_ } from "../runtime/grid.js";
import { autoResizeRows, formatCells, gridRange, mergeCells } from "../render/requests.js";

// header — header-row emphasis. Always runs: bolds, left-aligns, and wraps the
// header block, merges grouped-header spans (2-row headers, group labels on row
// 1), and bolds any column flagged bold.
export default definePrimitive({
  name: "header",
  region: "format",
  inputs: function (ctx) { return { h: ctx.headerRows, w: ctx.width, n: ctx.dataRowCount, bold: ctx.columns.map(function (c) { return !!c.bold; }), merges: ctx.spec.header_merges || null }; },
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
  requests(ctx) {
    const out = [
      formatCells(gridRange(ctx.sheetId, 1, 1, ctx.headerRows, ctx.width), { bold: true, align: "left", wrap: true }),
      autoResizeRows(ctx.sheetId, 1, ctx.headerRows),
    ];
    if (ctx.dataRowCount > 0) {
      ctx.columns.forEach((c, ci) => {
        if (c.bold) out.push(formatCells(gridRange(ctx.sheetId, ctx.firstDataRow, ci + 1, ctx.dataRowCount, 1), { bold: true }));
      });
    }
    const groupRow = ctx.headerRows >= 2 ? ctx.headerRows - 1 : 1;
    for (const m of ctx.spec.header_merges ?? []) {
      const from = columnIndex_(ctx.columns, m.from);
      const to = columnIndex_(ctx.columns, m.to);
      if (from > 0 && to > from) out.push(mergeCells(gridRange(ctx.sheetId, groupRow, from, 1, to - from + 1)));
    }
    return out;
  },
  render: function (ctx) {
    var sheet = ctx.sheet, columns = ctx.columns, width = ctx.width;

    sheet.getRange(1, 1, ctx.headerRows, width)
      .setFontWeight("bold")
      .setHorizontalAlignment("left")
      .setWrap(true);
    sheet.autoResizeRows(1, ctx.headerRows);

    if (ctx.dataRowCount > 0) {
      columns.forEach(function (c, ci) {
        if (c.bold) sheet.getRange(ctx.firstDataRow, ci + 1, ctx.dataRowCount, 1).setFontWeight("bold");
      });
    }

    // Group labels live on the second-to-last header row (the row above the
    // column names), so an optional banner above them doesn't shift the merge.
    var groupRow = ctx.headerRows >= 2 ? ctx.headerRows - 1 : 1;
    (ctx.spec.header_merges || []).forEach(function (m) {
      var from = columnIndex_(columns, m.from);
      var to = columnIndex_(columns, m.to);
      if (from > 0 && to > from) sheet.getRange(groupRow, from, 1, to - from + 1).merge();
    });
  },
});
