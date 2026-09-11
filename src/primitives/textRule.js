import { definePrimitive } from "../utils/define-primitive.js";

// textRule — background colour on cells whose text equals a value (PASS/FAIL,
// status flags). Pushes conditional-format rules onto ctx.cfRules; core installs
// them together with any gradient rules.
export default definePrimitive({
  name: "textRule",
  field: "text_rules",
  order: 40,
  render: function (ctx) {
    var range = ctx.sheet.getRange(1, 1, ctx.rows, ctx.width);
    (ctx.spec.text_rules || []).forEach(function (r) {
      ctx.cfRules.push(
        SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(r.equals).setBackground(r.color).setRanges([range]).build()
      );
    });
  },
});
