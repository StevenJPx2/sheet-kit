import { definePrimitive } from "../utils/define-primitive.js";
import { columnIndex_, matchLabel_ } from "../render/grid.js";
import { dimensionProps, formatCells, gridRange, mergeCells } from "../render/requests.js";

// rowLabel — style whole rows by matching a label column (section headers,
// cumulative rows, blank separators). Scans the label column so styling follows
// content, not hard-coded row numbers. match: {column,prefix,suffix,equals,empty};
// style: {bold,background,font_color,font_size,merge,row_height} (e.g. fold blank
// separators to row_height 8).
export default definePrimitive({
  name: "rowLabel",
  field: "row_label_styles",
  order: 50,
  validate(rules, columns) {
    for (const rule of rules ?? []) {
      const col = rule.match && rule.match.column;
      if (col != null && !columns.has(col)) return `row_label_style references unknown column ${JSON.stringify(col)}`;
    }
    return "";
  },
  requests(ctx) {
    const out = [];
    for (const rule of ctx.spec.row_label_styles || []) {
      const name = rule.match && rule.match.column;
      let col = name ? columnIndex_(ctx.columns, name) : 1;
      if (col <= 0) col = 1;
      const s = rule.style || {};
      const height = s.row_height;
      for (let i = ctx.firstDataRow - 1; i < ctx.values.length; i++) {
        if (!matchLabel_(String(ctx.values[i][col - 1] || ""), rule.match)) continue;
        const range = gridRange(ctx.sheetId, i + 1, 1, 1, ctx.width);
        if (s.merge) out.push(mergeCells(range));
        out.push(formatCells(range, {
          bold: s.bold, background: s.background,
          fontColor: s.font_color,
          fontSize: s.font_size,
        }));
        if (height) out.push(dimensionProps(ctx.sheetId, "ROWS", i + 1, 1, { pixelSize: height }));
      }
    }
    return out;
  },
});
