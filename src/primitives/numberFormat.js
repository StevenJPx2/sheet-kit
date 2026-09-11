import { definePrimitive } from "../utils/define-primitive.js";

// numberFormat — apply a Sheets number format ("$0.00", "0.0%", "#,##0", …) to
// a column's data rows.
export default definePrimitive({
  name: "numberFormat",
  field: "number_formats",
  order: 20,
  validate(formats, columns) {
    for (const nf of formats ?? []) {
      if (!columns.has(nf.column)) return `number_format references unknown column ${JSON.stringify(nf.column)}`;
    }
    return "";
  },
  render: function (ctx) {
    if (ctx.dataRowCount <= 0) return;
    (ctx.spec.number_formats || []).forEach(function (nf) {
      var column = columnIndex_(ctx.columns, nf.column);
      if (column > 0) ctx.sheet.getRange(ctx.firstDataRow, column, ctx.dataRowCount, 1).setNumberFormat(nf.format);
    });
  },
});
