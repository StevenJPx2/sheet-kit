// Primitive registry — the single list the renderer and validator walk.
// Adding a feature = author one primitive module with definePrimitive and add
// it here. Order in this array is irrelevant; rendering sorts by `order`.

import header from "./header.js";
import heading from "./heading.js";
import numberFormat from "./numberFormat.js";
import gradient from "./gradient.js";
import textRule from "./textRule.js";
import compareStyle from "./compareStyle.js";
import rowLabel from "./rowLabel.js";
import freeze from "./freeze.js";
import columnWidth from "./columnWidth.js";
import chart from "./chart.js";
import placement from "./placement.js";

/** @type {import("../utils/define-primitive.js").Primitive[]} */
export const PRIMITIVES = [
  header,
  heading,
  numberFormat,
  gradient,
  textRule,
  compareStyle,
  rowLabel,
  freeze,
  columnWidth,
  chart,
  placement,
];

/**
 * Select steps once per manifest, in render order. A used step runs for every
 * tab so that, for example, chart replacement clears charts from tabs whose
 * chart list is empty as well as tabs that add charts.
 * @param {import("../types.js").Tab[]} tabs
 */
export function usedPrimitives(tabs) {
  return PRIMITIVES.filter((p) => p.field === null || tabs.some((tab) => {
    const value = tab[p.field];
    return Array.isArray(value) ? value.length > 0 : value != null;
  })).sort((a, b) => a.order - b.order);
}

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
