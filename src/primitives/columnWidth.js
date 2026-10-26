import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_ } from "../render/grid.js";
import { dimensionProps } from "../render/requests.js";

// columnWidth — set pixel widths for named columns. column_widths: [{column, width}].
export default definePrimitive({
  name: "columnWidth",
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
});
