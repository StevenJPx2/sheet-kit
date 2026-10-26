import { definePrimitive } from "../utils/define-primitive.js";

// compareStyle — per row, style whichever of two columns holds the larger number.
// Cells may be formatted strings ("$3.46", "3.55%", "27,370"): the rule strips
// everything but digits/./- before comparing, and skips rows where either side
// isn't numeric (labels, blanks). Conditional-format based, so it stays right on
// re-render. style: { bold, italic, underline, strikethrough, font_color,
// background } — defaults to { bold: true }. (Only render() is serialised into
// the bundle, so helpers live inside it.)
const STYLE_KEYS = new Set(["bold", "italic", "underline", "strikethrough", "font_color", "background"]);

export default definePrimitive({
  name: "compareStyle",
  region: "cf",
  inputs: function (ctx) { return { c: ctx.spec.compare_style || null, r: ctx.firstDataRow, n: ctx.dataRowCount }; },
  field: "compare_style",
  order: 41,
  validate(pairs, columns) {
    for (const p of pairs ?? []) {
      for (const k of ["a", "b"]) {
        if (!columns.has(p[k])) return `compare_style references unknown column ${JSON.stringify(p[k])}`;
      }
      for (const k of Object.keys(p.style ?? {})) {
        if (!STYLE_KEYS.has(k)) return `compare_style: unknown style key ${JSON.stringify(k)}`;
      }
    }
    return "";
  },
  render: function (ctx) {
    var letter = function (index) {
      var s = "";
      while (index > 0) {
        var m = (index - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        index = (index - m - 1) / 26;
      }
      return s;
    };
    (ctx.spec.compare_style || []).forEach(function (p) {
      var a = columnIndex_(ctx.columns, p.a);
      var b = columnIndex_(ctx.columns, p.b);
      if (a <= 0 || b <= 0 || ctx.dataRowCount <= 0) return;
      var style = p.style || { bold: true };
      var row = ctx.firstDataRow;
      var num = function (col) {
        return 'IFERROR(VALUE(REGEXREPLACE($' + letter(col) + row + ',"[^0-9.\\-]","")),"")';
      };
      var formula = function (self, other) {
        var s = num(self), o = num(other);
        // Guard blanks: VALUE("") is 0 in Sheets, so an empty peer would look
        // like a real 0 and wrongly "win". Require both cells non-empty.
        var a = "$" + letter(self) + row, b = "$" + letter(other) + row;
        return "=AND(" + a + '<>"",' + b + '<>"",ISNUMBER(' + s + "),ISNUMBER(" + o + ")," + s + ">" + o + ")";
      };
      [[a, b], [b, a]].forEach(function (pair) {
        var range = ctx.sheet.getRange(ctx.firstDataRow, pair[0], ctx.dataRowCount, 1);
        var rule = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula(pair[0], pair[1]));
        if (style.bold) rule.setBold(true);
        if (style.italic) rule.setItalic(true);
        if (style.underline) rule.setUnderline(true);
        if (style.strikethrough) rule.setStrikethrough(true);
        if (style.font_color) rule.setFontColor(style.font_color);
        if (style.background) rule.setBackground(style.background);
        ctx.cfRules.push(rule.setRanges([range]).build());
      });
    });
  },
});
