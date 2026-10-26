import { definePrimitive } from "../utils/define-primitive.js";
import { colorStyle, gridRange } from "../render/requests.js";

// textRule — background colour on cells whose text equals a value (PASS/FAIL,
// status flags). Pushes conditional-format rules onto ctx.cfRules; the renderer installs
// them together with any gradient rules.
export default definePrimitive({
  name: "textRule",
  field: "text_rules",
  order: 40,
  requests(ctx) {
    const range = gridRange(ctx.sheetId, 1, 1, ctx.rows, ctx.width);
    for (const r of ctx.spec.text_rules || []) {
      ctx.cfRules.push({
        ranges: [range],
        booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: r.equals }] }, format: { backgroundColorStyle: colorStyle(r.color) } },
      });
    }
    return [];
  },
});
