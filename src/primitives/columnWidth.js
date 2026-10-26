import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_ } from "../runtime/grid.js";
import { dimensionProps } from "../render/requests.js";

// columnWidth — set pixel widths for named columns. column_widths: [{column, width}].
export default definePrimitive({
  name: "columnWidth",
  region: "sheet",
  inputs: function (ctx) { return ctx.spec.column_widths || null; },
  field: "column_widths",
  order: 70,
  validate(widths, columns) {
    for (const w of widths ?? []) {
      if (!columns.has(w.column)) return `column_width references unknown column ${JSON.stringify(w.column)}`;
    }
    return "";
  },
  requests(ctx) {
    return (ctx.spec.column_widths || []).map((w) => {
      const column = columnIndex_(ctx.columns, w.column);
      return column > 0 ? dimensionProps(ctx.sheetId, "COLUMNS", column, 1, { pixelSize: w.width }) : null;
    });
  },
  render: function (ctx) {
    (ctx.spec.column_widths || []).forEach(function (w) {
      var column = columnIndex_(ctx.columns, w.column);
      if (column > 0) ctx.sheet.setColumnWidth(column, w.width);
    });
  },
});
