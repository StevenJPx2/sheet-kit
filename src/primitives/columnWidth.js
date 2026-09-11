import { definePrimitive } from "../utils/define-primitive.js";

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
  render: function (ctx) {
    (ctx.spec.column_widths || []).forEach(function (w) {
      var column = columnIndex_(ctx.columns, w.column);
      if (column > 0) ctx.sheet.setColumnWidth(column, w.width);
    });
  },
});
