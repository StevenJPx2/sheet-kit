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
// core.js records which sheet rows are sections/headers; this primitive styles
// them. Positions come from data; styles come from the manifest.
export default definePrimitive({
  name: "heading",
  region: "format",
  inputs: function (ctx) { return { styles: ctx.spec.headings || null, w: ctx.width, sections: ctx.sections, headers: ctx.headers }; },
  field: "headings",
  order: 15,
  requests(ctx) {
    const styles = ctx.spec.headings || {};
    const out = [];
    /** Mirror of render's apply(); `wrap` lets __header__ rows force wrapping. */
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
  render: function (ctx) {
    var styles = ctx.spec.headings || {};

    function apply(range, style, row) {
      var merged = style.merge !== false;
      if (merged) range.merge();
      // A merged heading wraps within its cell instead of overflowing across the
      // row; a non-merged heading keeps its single cell (text may clip).
      range.setWrap(merged);
      if (style.bold) range.setFontWeight("bold");
      if (style.italic) range.setFontStyle("italic");
      if (style.background) range.setBackground(style.background);
      if (style.font_color) range.setFontColor(style.font_color);
      if (style.font_size) range.setFontSize(style.font_size);
      if (style.align) range.setHorizontalAlignment(style.align);
      if (style.row_height) ctx.sheet.setRowHeight(row, style.row_height);
    }

    (ctx.sections || []).forEach(function (s) {
      var style = styles[s.level] || styles.section || { bold: true, background: "#eef5fb" };
      apply(ctx.sheet.getRange(s.row, 1, 1, ctx.width), style, s.row);
    });

    (ctx.headers || []).forEach(function (h) {
      var style = styles.header || { bold: true, background: "#e8eef2", merge: false };
      var range = ctx.sheet.getRange(h.row, 1, 1, ctx.width);
      apply(range, style, h.row);
      range.setWrap(true);
      ctx.sheet.autoResizeRows(h.row, 1);
    });
  },
});
