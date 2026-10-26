import { definePrimitive } from "../utils/define-primitive.js";

const GRADIENT_KINDS = new Set(["number", "percent", "percentile", "min", "max"]);

// gradient (a.k.a. colors) — a per-column conditional-format colour scale.
// Independent min/mid/max interpolation (min_kind/mid_kind/max_kind) lets an
// all-positive metric use a median-centred white midpoint instead of a muddy
// red→green blend. group_by splits the column into independent scales per
// contiguous run of that column's value (e.g. Top Products by Section).
export default definePrimitive({
  name: "gradient",
  region: "cf",
  inputs: function (ctx) {
    return { g: ctx.spec.gradients || null, r: ctx.firstDataRow, n: ctx.dataRowCount,
      runs: (ctx.spec.gradients || []).map(function (g) { return g.group_by ? gradientRuns_(ctx.values, ctx.columns, ctx.firstDataRow, ctx.dataRowCount, g.group_by) : null; }) };
  },
  field: "gradients",
  order: 30,
  validate(gradients, columns) {
    for (const g of gradients ?? []) {
      if (!columns.has(g.column)) return `gradient references unknown column ${JSON.stringify(g.column)}`;
      if (!GRADIENT_KINDS.has(g.kind)) return `gradient on ${JSON.stringify(g.column)}: invalid kind ${JSON.stringify(g.kind)}`;
      for (const k of ["min_kind", "mid_kind", "max_kind"]) {
        if (g[k] != null && !GRADIENT_KINDS.has(g[k])) return `gradient on ${JSON.stringify(g.column)}: invalid ${k} ${JSON.stringify(g[k])}`;
      }
      if (g.group_by != null && !columns.has(g.group_by)) return `gradient on ${JSON.stringify(g.column)}: unknown group_by column ${JSON.stringify(g.group_by)}`;
    }
    return "";
  },
  render: function (ctx) {
    var INTERP = { number: "NUMBER", percent: "PERCENT", percentile: "PERCENTILE", min: "MIN", max: "MAX" };
    (ctx.spec.gradients || []).forEach(function (g) {
      var column = columnIndex_(ctx.columns, g.column);
      if (column <= 0) return;

      var runs = gradientRuns_(ctx.values, ctx.columns, ctx.firstDataRow, ctx.dataRowCount, g.group_by);
      var rule = SpreadsheetApp.newConditionalFormatRule();
      var minInterp = INTERP[g.min_kind || g.kind] || "PERCENTILE";
      var midInterp = INTERP[g.mid_kind || "number"] || "NUMBER";
      var maxInterp = INTERP[g.max_kind || g.kind] || "PERCENTILE";

      // MIN/MAX endpoints auto-anchor to the range's actual extremes (linear, not
      // rank-based) — use the no-value setters; NUMBER/PERCENT/PERCENTILE take a value.
      if ((g.min_kind || g.kind) === "min") {
        rule.setGradientMinpoint(g.min_color || "#ea4335");
      } else {
        rule.setGradientMinpointWithValue(g.min_color || "#ea4335", SpreadsheetApp.InterpolationType[minInterp], String(g.min_value != null ? g.min_value : 2));
      }
      if (g.mid_color != null) {
        rule.setGradientMidpointWithValue(g.mid_color, SpreadsheetApp.InterpolationType[midInterp], String(g.mid_value != null ? g.mid_value : 0));
      }
      if ((g.max_kind || g.kind) === "max") {
        rule.setGradientMaxpoint(g.max_color || "#34a853");
      } else {
        rule.setGradientMaxpointWithValue(g.max_color || "#34a853", SpreadsheetApp.InterpolationType[maxInterp], String(g.max_value != null ? g.max_value : 98));
      }

      ctx.cfRules.push(rule.setRanges(runs.map(function (run) {
        return ctx.sheet.getRange(run.firstRow, column, run.rowCount, 1);
      })).build());
    });
  },
});
