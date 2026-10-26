import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, gradientPoints_, gradientRuns_ } from "../runtime/grid.js";
import { colorStyle, gridRange } from "../render/requests.js";

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
  requests(ctx) {
    const point = (/** @type {{ color: string, type: string, value?: string }} */ p) =>
      ({ colorStyle: colorStyle(p.color), type: p.type, ...(p.value != null ? { value: p.value } : {}) });
    for (const g of ctx.spec.gradients || []) {
      const column = columnIndex_(ctx.columns, g.column);
      if (column <= 0) continue;
      const runs = gradientRuns_(ctx.values, ctx.columns, ctx.firstDataRow, ctx.dataRowCount, g.group_by);
      const p = gradientPoints_(g);
      ctx.cfRules.push({
        ranges: runs.map((run) => gridRange(ctx.sheetId, run.firstRow, column, run.rowCount, 1)),
        gradientRule: { minpoint: point(p.min), ...(p.mid ? { midpoint: point(p.mid) } : {}), maxpoint: point(p.max) },
      });
    }
    return [];
  },
  render: function (ctx) {
    (ctx.spec.gradients || []).forEach(function (g) {
      var column = columnIndex_(ctx.columns, g.column);
      if (column <= 0) return;

      var runs = gradientRuns_(ctx.values, ctx.columns, ctx.firstDataRow, ctx.dataRowCount, g.group_by);
      var p = gradientPoints_(g);
      var rule = SpreadsheetApp.newConditionalFormatRule();

      // MIN/MAX endpoints auto-anchor to the range's actual extremes (linear, not
      // rank-based) — use the no-value setters; NUMBER/PERCENT/PERCENTILE take a value.
      if (p.min.value == null) rule.setGradientMinpoint(p.min.color);
      else rule.setGradientMinpointWithValue(p.min.color, SpreadsheetApp.InterpolationType[p.min.type], p.min.value);
      if (p.mid) rule.setGradientMidpointWithValue(p.mid.color, SpreadsheetApp.InterpolationType[p.mid.type], p.mid.value);
      if (p.max.value == null) rule.setGradientMaxpoint(p.max.color);
      else rule.setGradientMaxpointWithValue(p.max.color, SpreadsheetApp.InterpolationType[p.max.type], p.max.value);

      ctx.cfRules.push(rule.setRanges(runs.map(function (run) {
        return ctx.sheet.getRange(run.firstRow, column, run.rowCount, 1);
      })).build());
    });
  },
});
