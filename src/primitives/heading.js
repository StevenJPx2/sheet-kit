import { definePrimitive } from "../utils/define-primitive.js";
import { autoResizeRows, dimensionProps, formatCells, gridRange, mergeCells } from "../render/requests.js";

// heading — standalone section headings and stacked sub-table headers.
//
// A data row with __section__ (text) + optional __level renders as a merged cell
// spanning the tab width, styled by headings[level]. A row with __header__ re-
// emits the column headers (a new stacked sub-table), styled by headings.header.
// This is what lets one tab hold a title, a methodology subtitle, and multiple
// dated sub-tables (top-products, web-metrics, hourly's two blocks). Heading text
// is dynamic (dates per run), so it travels in the data rows, not the manifest.
//
// The manifest declares only the per-level STYLES:
//   headings: { title:{…}, period:{…}, summary:{…}, header:{…} }
// grid.js records which sheet rows are sections/headers; this primitive styles
// them. Positions come from data; styles come from the manifest.
export default definePrimitive({
  name: "heading",
  field: "headings",
  order: 15,
  requests(ctx) {
    const styles = ctx.spec.headings || {};
    const out = [];
    // Repeated column headers wrap even when their cells are not merged.
    const apply = (row, style, wrap) => {
      const range = gridRange(ctx.sheetId, row, 1, 1, ctx.width);
      const merged = style.merge !== false;
      if (merged) out.push(mergeCells(range));
      out.push(formatCells(range, {
        wrap: wrap ?? merged,
        bold: style.bold, italic: style.italic, background: style.background,
        fontColor: style.font_color, fontSize: style.font_size, align: style.align,
      }));
      if (style.row_height) out.push(dimensionProps(ctx.sheetId, "ROWS", row, 1, { pixelSize: style.row_height }));
    };
    for (const s of ctx.sections) apply(s.row, styles[s.level] || styles.section || { bold: true, background: "#eef5fb" });
    for (const h of ctx.headers) {
      apply(h.row, styles.header || { bold: true, background: "#e8eef2", merge: false }, true);
      out.push(autoResizeRows(ctx.sheetId, h.row, 1));
    }
    return out;
  },
});
