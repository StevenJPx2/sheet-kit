import { definePrimitive } from "../utils/define-primitive.js";
import { chartLayout_ } from "../runtime/grid.js";
import { colorStyle, dimensionProps, gridRange } from "../render/requests.js";

const LEGEND = /** @type {Record<string, string>} */ ({
  bottom: "BOTTOM_LEGEND", top: "TOP_LEGEND", left: "LEFT_LEGEND", right: "RIGHT_LEGEND", none: "NO_LEGEND",
});

/**
 * The Sheets API EmbeddedChart for a manifest line chart. Google Charts options
 * (`options`, `v_axis_format`) are mapped where the API has an equivalent;
 * the rest are reported in ctx.warnings and skipped.
 * @param {import("../utils/define-primitive.js").ApiCtx} ctx
 * @param {any} c
 * @param {{ headerRow: number, height: number, cols: number[], row: number, col: number }} layout
 */
function embeddedChart(ctx, c, layout) {
  const source = (/** @type {number} */ col) => ({ sourceRange: { sources: [gridRange(ctx.sheetId, layout.headerRow, col, layout.height, 1)] } });
  const [x, ...seriesCols] = layout.cols;
  /** @type {Record<string, any>} */
  const basic = {
    chartType: "LINE",
    headerCount: c.num_headers != null ? c.num_headers : 1,
    domains: [{ domain: source(x) }],
    series: seriesCols.map((col) => ({ series: source(col), targetAxis: "LEFT_AXIS" })),
  };
  /** @type {Record<string, any>} */
  const spec = { ...(c.title ? { title: c.title } : {}), basicChart: basic };
  if (c.v_axis_format) ctx.warnings.push(`chart ${JSON.stringify(c.title ?? c.x)}: v_axis_format has no Sheets API equivalent (the axis follows the data's number format)`);
  applyColors(basic, c.colors);
  for (const [key, value] of Object.entries(c.options || {})) {
    if (!applyOption(spec, basic, key, value)) ctx.warnings.push(`chart ${JSON.stringify(c.title ?? c.x)}: option ${JSON.stringify(key)} has no Sheets API equivalent; ignored`);
  }
  if (c.hide_data) spec.hiddenDimensionStrategy = "SHOW_ALL";
  return {
    spec,
    position: {
      overlayPosition: {
        anchorCell: { sheetId: ctx.sheetId, rowIndex: Math.max(0, (layout.row || 1) - 1), columnIndex: Math.max(0, (layout.col || 1) - 1) },
        offsetXPixels: 0,
        offsetYPixels: 0,
        widthPixels: c.width || 920,
        heightPixels: c.height || 400,
      },
    },
  };
}

/** @param {Record<string, any>} basic @param {string[] | undefined} colors */
function applyColors(basic, colors) {
  (colors || []).forEach((color, i) => { if (basic.series[i]) basic.series[i].colorStyle = colorStyle(color); });
}

/** @param {Record<string, any>} basic @param {string} position */
function axis(basic, position) {
  basic.axis = basic.axis || [];
  let a = basic.axis.find((/** @type {any} */ e) => e.position === position);
  if (!a) { a = { position }; basic.axis.push(a); }
  return a;
}

/**
 * Map one Google Charts option onto the API spec; false when unsupported.
 * @param {Record<string, any>} spec
 * @param {Record<string, any>} basic
 * @param {string} key
 * @param {any} value
 */
function applyOption(spec, basic, key, value) {
  switch (key) {
    case "title": spec.title = String(value); return true;
    case "colors": applyColors(basic, value); return true;
    case "legend": return applyOption(spec, basic, "legend.position", value && value.position);
    case "legend.position": if (!LEGEND[value]) return false; basic.legendPosition = LEGEND[value]; return true;
    case "curveType": basic.lineSmoothing = value === "function"; return true;
    case "interpolateNulls": basic.interpolateNulls = Boolean(value); return true;
    case "hAxis.title": axis(basic, "BOTTOM_AXIS").title = String(value); return true;
    case "vAxis.title": axis(basic, "LEFT_AXIS").title = String(value); return true;
    case "vAxis.viewWindow.min": axis(basic, "LEFT_AXIS").viewWindowOptions = { ...axis(basic, "LEFT_AXIS").viewWindowOptions, viewWindowMode: "EXPLICIT", viewWindowMin: Number(value) }; return true;
    case "vAxis.viewWindow.max": axis(basic, "LEFT_AXIS").viewWindowOptions = { ...axis(basic, "LEFT_AXIS").viewWindowOptions, viewWindowMode: "EXPLICIT", viewWindowMax: Number(value) }; return true;
    case "series": return Object.entries(value || {}).every(([i, opts]) => applySeries(basic.series[Number(i)], opts));
    default: return false;
  }
}

/**
 * Per-series Google Charts options (series: { "1": {...} }).
 * @param {Record<string, any> | undefined} series
 * @param {Record<string, any>} opts
 */
function applySeries(series, opts) {
  if (!series) return false;
  let ok = true;
  for (const [k, v] of Object.entries(opts || {})) {
    if (k === "color") series.colorStyle = colorStyle(v);
    // The API has preset dash types only; any dash pattern becomes MEDIUM_DASHED.
    else if (k === "lineDashStyle") series.lineStyle = { ...series.lineStyle, type: Array.isArray(v) && v.length ? "MEDIUM_DASHED" : "SOLID" };
    else if (k === "lineWidth") series.lineStyle = { ...series.lineStyle, width: Number(v) };
    else if (k === "targetAxisIndex") series.targetAxis = Number(v) === 1 ? "RIGHT_AXIS" : "LEFT_AXIS";
    else ok = false;
  }
  return ok;
}

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
  requests(ctx) {
    // Replace, never stack: every chart on the tab goes first (as render does).
    /** @type {import("../render/requests.js").Request[]} */
    const out = ctx.sheet.chartIds.map((objectId) => ({ deleteEmbeddedObject: { objectId } }));
    const charts = ctx.spec.charts || [];
    if (charts.some((c) => c.hide_data)) {
      out.push(dimensionProps(ctx.sheetId, "ROWS", 1, ctx.sheet.gridRows, { hiddenByUser: false }));
      out.push(dimensionProps(ctx.sheetId, "COLUMNS", 1, ctx.sheet.gridColumns, { hiddenByUser: false }));
    }
    for (const c of charts) {
      const layout = chartLayout_(ctx, c);
      if (!layout) continue;
      out.push({ addChart: { chart: embeddedChart(ctx, c, layout) } });
      if (c.hide_data) {
        out.push(dimensionProps(ctx.sheetId, "ROWS", layout.headerRow, layout.height, { hiddenByUser: true }));
        for (const col of layout.cols) out.push(dimensionProps(ctx.sheetId, "COLUMNS", col, 1, { hiddenByUser: true }));
      }
    }
    return out;
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
