import { definePrimitive } from "../utils/define-primitive.js";

// chart — embed charts driven by named columns. Currently line charts:
// charts: [{type:"line", title, x, series:[..], num_headers, v_axis_format,
//           colors:[], width, height, position:{row,col}}]. x/series address
// columns by NAME; the compiler-independent runtime resolves them to A1 ranges.
// Removes existing charts first so re-renders don't stack duplicates.
//
// For a chart inside a stacked tab (headings, sub-tables), three options:
//   data_from_last_header: the data starts at the tab's last __header__ row
//     (its column names are the series names) and runs to the end of the data,
//     instead of starting at the top header row.
//   anchor_section: place the chart at the first heading row of this __level
//     (position.col still applies; give the level a tall row_height to make room).
//   hide_data: hide the chart's data rows and x/series columns (the chart
//     still plots them).
//   options: extra chart options passed to setOption as-is, e.g.
//     {"series": {"1": {"lineDashStyle": [4, 4]}}, "legend.position": "bottom"}.
export default definePrimitive({
  name: "chart",
  region: "chart",
  inputs: function (ctx) {
    if (!(ctx.spec.charts || []).length) return null;
    return { c: ctx.spec.charts, h: ctx.headerRows, n: ctx.dataRowCount, rows: ctx.rows, hdr: ctx.headers, sec: ctx.sections };
  },
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

    var charts = ctx.spec.charts || [];
    if (charts.some(function (c) { return c.hide_data; })) {
      sheet.showRows(1, sheet.getMaxRows());
      sheet.showColumns(1, sheet.getMaxColumns());
    }

    charts.forEach(function (c) {
      var layout = chartLayout_(ctx, c);
      if (!layout) return;
      var headerRow = layout.headerRow, height = layout.height, cols = layout.cols;

      var builder = sheet.newChart().asLineChart();
      cols.forEach(function (col) { builder.addRange(sheet.getRange(headerRow, col, height, 1)); });

      builder.setNumHeaders(c.num_headers != null ? c.num_headers : 1);
      if (c.title) builder.setTitle(c.title);
      if (c.v_axis_format) builder.setOption("vAxis.format", c.v_axis_format);
      if (c.colors) builder.setOption("colors", c.colors);
      Object.keys(c.options || {}).forEach(function (k) { builder.setOption(k, c.options[k]); });
      builder.setOption("width", c.width || 920).setOption("height", c.height || 400);

      builder.setPosition(layout.row, layout.col, 0, 0);

      if (c.hide_data) {
        builder.setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH);
        sheet.hideRows(headerRow, height);
        cols.forEach(function (col) { sheet.hideColumns(col); });
      }
      sheet.insertChart(builder.build());
    });
  },
});
