import { definePrimitive } from "../utils/define-primitive.js";

const POSITIONS = new Set(["first", "last"]);

// placement — where the tab sits and whether it shows. placement: {position?, hidden?}.
// position "first"/"last" moves the tab to that end of the tab bar; hidden true
// hides it, false shows it, absent leaves a manual hide alone.
export default definePrimitive({
  name: "placement",
  field: "placement",
  order: 90,
  validate(placement) {
    if (placement == null) return "";
    if (typeof placement !== "object" || Array.isArray(placement)) return "placement must be an object";
    if (placement.position != null && !POSITIONS.has(placement.position)) {
      return `placement.position must be "first" or "last", got ${JSON.stringify(placement.position)}`;
    }
    if (placement.hidden != null && typeof placement.hidden !== "boolean") return "placement.hidden must be a boolean";
    return "";
  },
  requests(ctx) {
    const placement = ctx.spec.placement;
    if (!placement) return [];
    const out = [];
    // Indexes count "before the move"; the
    // API ignores a move to the current index (or current + 1), so "last" is a
    // no-op for a tab that is already last.
    if (placement.position) {
      const index = placement.position === "last" ? ctx.sheet.sheetCount : 0;
      out.push({ updateSheetProperties: { properties: { sheetId: ctx.sheetId, index }, fields: "index" } });
    }
    if (typeof placement.hidden === "boolean" && placement.hidden !== ctx.sheet.hidden) {
      out.push({ updateSheetProperties: { properties: { sheetId: ctx.sheetId, hidden: placement.hidden }, fields: "hidden" } });
    }
    return out;
  },
});
