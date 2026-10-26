import assert from "node:assert/strict";
import { test } from "node:test";
import { usedPrimitives } from "./index.js";
import { definePrimitive } from "../utils/define-primitive.js";

test("select only required steps, always include header, and order them", () => {
  assert.deepEqual(usedPrimitives([{ columns: [] }]).map((p) => p.name), ["header"]);
  assert.deepEqual(usedPrimitives([{ gradients: [{ column: "RPV" }], charts: [] }]).map((p) => p.name), ["header", "gradient"]);
  assert.deepEqual(usedPrimitives([{ charts: [{ type: "line" }] }, { freeze: { rows: 1 } }]).map((p) => p.name), ["header", "freeze", "chart"]);
});

test("a primitive has only validation and request behaviour", () => {
  const primitive = definePrimitive({ name: "example", requests: () => [] });
  assert.deepEqual(Object.keys(primitive).sort(), ["field", "name", "order", "requests", "validate"]);
  assert.equal(primitive.validate(undefined, new Set(), {}), "");
  assert.throws(() => definePrimitive({ name: "", requests: () => [] }), /name is required/);
  assert.throws(() => definePrimitive({ name: "bad" }), /requests must be a function/);
});
