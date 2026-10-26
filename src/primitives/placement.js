import { definePrimitive } from "../utils/define-primitive.js";

const POSITIONS = new Set(["first", "last"]);

// placement — where the tab sits and whether it shows. placement: {position?, hidden?}.
// position "first"/"last" moves the tab to that end of the tab bar; hidden true
// hides it, false shows it, absent leaves a manual hide alone. Re-applied when
// the placement changes and on every full render.
export default definePrimitive({
  name: "placement",
  region: "sheet",
  inputs: function (ctx) { return ctx.spec.placement || null; },
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
    // Move before hiding, as render does. Indexes count "before the move"; the
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
  render: function (ctx) {
    var placement = ctx.spec.placement;
    if (!placement) return;
    var sheet = ctx.sheet;
    var spreadsheet = sheet.getParent();

    // Move before hiding: activating a sheet to move it would show it again.
    if (placement.position) {
      var target = placement.position === "last" ? spreadsheet.getNumSheets() : 1;
      if (sheet.getIndex() !== target) {
        spreadsheet.setActiveSheet(sheet);
        spreadsheet.moveActiveSheet(target);
      }
    }

    if (placement.hidden === true && !sheet.isSheetHidden()) sheet.hideSheet();
    if (placement.hidden === false && sheet.isSheetHidden()) sheet.showSheet();
  },
});
