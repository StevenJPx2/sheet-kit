import { definePrimitive } from "../utils/define-primitive.js";
import { gridProps } from "../render/requests.js";

// freeze — freeze header rows and/or leading columns. freeze: {rows, cols}.
export default definePrimitive({
  name: "freeze",
  region: "sheet",
  inputs: function (ctx) { return ctx.spec.freeze || null; },
  field: "freeze",
  order: 60,
  requests(ctx) {
    const freeze = ctx.spec.freeze;
    if (!freeze) return [];
    /** @type {Record<string, number>} */
    const grid = {};
    if (freeze.rows) grid.frozenRowCount = freeze.rows;
    if (freeze.cols) grid.frozenColumnCount = freeze.cols;
    return Object.keys(grid).length ? [gridProps(ctx.sheetId, grid)] : [];
  },
  render: function (ctx) {
    var freeze = ctx.spec.freeze;
    if (!freeze) return;
    if (freeze.rows) ctx.sheet.setFrozenRows(freeze.rows);
    if (freeze.cols) ctx.sheet.setFrozenColumns(freeze.cols);
  },
});
