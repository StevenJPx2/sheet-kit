// Primitive registry — the single list the compiler and validator walk.
// Adding a feature = author one primitive module with definePrimitive and add
// it here. Order in this array is irrelevant; the compiler sorts by `order`.

import header from "./header.js";
import heading from "./heading.js";
import numberFormat from "./numberFormat.js";
import gradient from "./gradient.js";
import textRule from "./textRule.js";
import rowLabel from "./rowLabel.js";
import freeze from "./freeze.js";
import columnWidth from "./columnWidth.js";
import chart from "./chart.js";

/** @type {import("../utils/define-primitive.js").Primitive[]} */
export const PRIMITIVES = [
  header,
  heading,
  numberFormat,
  gradient,
  textRule,
  rowLabel,
  freeze,
  columnWidth,
  chart,
];

const names = new Set();
const fields = new Set();
for (const primitive of PRIMITIVES) {
  if (names.has(primitive.name)) throw new Error(`duplicate primitive name ${primitive.name}`);
  names.add(primitive.name);
  if (primitive.field != null) {
    if (fields.has(primitive.field)) throw new Error(`duplicate primitive field ${primitive.field}`);
    fields.add(primitive.field);
  }
}
