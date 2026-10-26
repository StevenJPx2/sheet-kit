import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, gradientPoints_, gradientRuns_ } from "../render/grid.js";
import { colorStyle, gridRange } from "../render/requests.js";

const GRADIENT_KINDS = new Set(["number", "percent", "percentile", "min", "max"]);

// gradient (a.k.a. colors) — a per-column conditional-format colour scale.
// Independent min/mid/max interpolation (min_kind/mid_kind/max_kind) lets an
// all-positive metric use a median-centred white midpoint instead of a muddy
// red→green blend. group_by splits the column into independent scales per
// contiguous run of that column's value (e.g. Top Products by Section).
export default definePrimitive({
  name: "gradient",
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
});
