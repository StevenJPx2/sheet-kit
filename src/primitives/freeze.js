import { definePrimitive } from "../utils/define-primitive.js";

// freeze — freeze header rows and/or leading columns. freeze: {rows, cols}.
export default definePrimitive({
  name: "freeze",
  region: "sheet",
  inputs: function (ctx) { return ctx.spec.freeze || null; },
  field: "freeze",
  order: 60,
  render: function (ctx) {
    var freeze = ctx.spec.freeze;
    if (!freeze) return;
    if (freeze.rows) ctx.sheet.setFrozenRows(freeze.rows);
    if (freeze.cols) ctx.sheet.setFrozenColumns(freeze.cols);
  },
});
