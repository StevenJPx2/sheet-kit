import { definePrimitive } from "../utils/define-primitive.js";

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
  field: "headings",
  order: 15,
  render: function (ctx) {
    var styles = ctx.spec.headings || {};

    function apply(range, style, row) {
      if (style.merge !== false) range.merge();
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
      apply(ctx.sheet.getRange(h.row, 1, 1, ctx.width), style, h.row);
    });
  },
});
