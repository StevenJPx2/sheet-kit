// A primitive owns its manifest field, validation, and Sheets API requests.

/**
 * @typedef {Object} ApiCtx
 * Per-tab input to a primitive, built by render/render.js.
 * @property {number} sheetId
 * @property {import("../types.js").Tab} spec
 * @property {import("../types.js").Column[]} columns
 * @property {unknown[][]} values
 * @property {number} width
 * @property {number} rows
 * @property {number} headerRows
 * @property {number} firstDataRow 1-based
 * @property {number} dataRowCount
 * @property {Array<{row: number, level?: string}>} sections
 * @property {Array<{row: number}>} headers
 * @property {{ gridRows: number, gridColumns: number, chartIds: number[], hidden: boolean, sheetCount: number }} sheet
 * @property {import("../render/requests.js").Request[]} cfRules Rules installed after the primitives run, in order.
 * @property {string[]} warnings Unsupported manifest features, reported once per publish.
 */

/**
 * @typedef {Object} PrimitiveSpec
 * @property {string} name
 * @property {string|null} [field] Manifest field, null = always run.
 * @property {number} [order] Lower first; default 50.
 * @property {(value: any, columns: Set<string>, tab: import("../types.js").Tab) => string} [validate]
 * @property {(ctx: ApiCtx) => (import("../render/requests.js").Request | null)[]} requests
 *
 * @typedef {Object} Primitive
 * @property {string} name
 * @property {string|null} field
 * @property {number} order
 * @property {NonNullable<PrimitiveSpec["validate"]>} validate
 * @property {PrimitiveSpec["requests"]} requests
 */

/** @param {PrimitiveSpec} spec @returns {Primitive} */
export function definePrimitive(spec) {
  if (!spec || typeof spec.name !== "string" || !spec.name) throw new Error("definePrimitive: name is required");
  if (typeof spec.requests !== "function") throw new Error(`definePrimitive(${spec.name}): requests must be a function`);
  return {
    name: spec.name,
    field: spec.field ?? null,
    order: spec.order ?? 50,
    validate: spec.validate ?? (() => ""),
    requests: spec.requests,
  };
}
