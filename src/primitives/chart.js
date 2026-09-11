import { definePrimitive } from "../utils/define-primitive.js";

// chart — embed charts driven by named columns. Currently line charts:
// charts: [{type:"line", title, x, series:[..], num_headers, v_axis_format,
//           colors:[], width, height, position:{row,col}}]. x/series address
// columns by NAME; the compiler-independent runtime resolves them to A1 ranges.
// Removes existing charts first so re-renders don't stack duplicates.
export default definePrimitive({
  name: "chart",
  field: "charts",
  order: 80,
  validate(charts, columns) {
    for (const c of charts ?? []) {
      if (c.type !== "line") return `chart: unsupported type ${JSON.stringify(c.type)}`;
      if (!columns.has(c.x)) return `chart references unknown x column ${JSON.stringify(c.x)}`;
      if (!Array.isArray(c.series) || c.series.length === 0) return "chart requires at least one series column";
      for (const s of c.series ?? []) {
        if (!columns.has(s)) return `chart references unknown series column ${JSON.stringify(s)}`;
      }
    }
    return "";
  },
  render: function (ctx) {
    var sheet = ctx.sheet;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var existing = sheet.getCharts();
        if (!existing.length) break;
        existing.forEach(function (c) { try { sheet.removeChart(c); } catch (ignore) {} });
      } catch (ignore) { SpreadsheetApp.flush(); }
    }

    (ctx.spec.charts || []).forEach(function (c) {
      var headerRow = ctx.headerRows;
      var xColumn = columnIndex_(ctx.columns, c.x);
      if (xColumn <= 0) return;

      var builder = sheet.newChart().asLineChart()
        .addRange(sheet.getRange(headerRow, xColumn, ctx.dataRowCount + 1, 1));
      (c.series || []).forEach(function (name) {
        var col = columnIndex_(ctx.columns, name);
        if (col > 0) builder.addRange(sheet.getRange(headerRow, col, ctx.dataRowCount + 1, 1));
      });

      builder.setNumHeaders(c.num_headers != null ? c.num_headers : 1);
      if (c.title) builder.setTitle(c.title);
      if (c.v_axis_format) builder.setOption("vAxis.format", c.v_axis_format);
      if (c.colors) builder.setOption("colors", c.colors);
      builder.setOption("width", c.width || 920).setOption("height", c.height || 400);
      var pos = c.position || { row: 4, col: 0 };
      builder.setPosition(pos.row, pos.col, 0, 0);
      sheet.insertChart(builder.build());
    });
  },
});
