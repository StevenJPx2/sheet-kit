// definePrimitive — the builder every sheet-kit feature is authored with.
//
// A primitive is one self-contained module: it owns its manifest field, its
// schema check (validate), its Sheets API behaviour (requests, run in Node by
// src/render/render.js) and its legacy Apps Script behaviour (render). The compiler
// imports these definitions, includes only the ones a manifest uses, serialises
// each render into the bundle, and wires the dispatch order. There is no flat
// contract and no hand-maintained Apps Script — both are produced from these.

/**
 * @typedef {Object} RenderCtx
 * The per-tab context passed to a primitive's render at run time (inside Apps
 * Script). Core builds it; primitives read from it and mutate the sheet and/or
 * push conditional-format rules onto cfRules.
 * @property {any}       sheet         The Sheet being rendered.
 * @property {any}       spec          The manifest tab spec (raw, incl. this primitive's field).
 * @property {any[]}     columns       spec.columns.
 * @property {any[][]}   values        Normalised 2D grid already written to the sheet.
 * @property {number}    width         Column count.
 * @property {number}    rows          Total written rows (headers + data).
 * @property {number}    headerRows    Number of header rows.
 * @property {number}    firstDataRow  1-based sheet row of the first data row.
 * @property {number}    dataRowCount  Number of data rows.
 * @property {Array<{row:number, level?:string}>} sections  1-based sheet rows of merged heading rows.
 * @property {Array<{row:number}>}                 headers   1-based sheet rows of repeated sub-table headers.
 * @property {any[]}     cfRules       Collected conditional-format rules (gradient/textRule push here).
 */

/**
 * @typedef {Object} ApiCtx
 * The per-tab context passed to a primitive's `requests` in Node (the Sheets
 * API renderer). Same layout fields as RenderCtx, but instead of a live sheet
 * it carries the sheet's id and what the renderer read before rendering.
 * @property {number}    sheetId
 * @property {any}       spec
 * @property {any[]}     columns
 * @property {any[][]}   values
 * @property {number}    width
 * @property {number}    rows
 * @property {number}    headerRows
 * @property {number}    firstDataRow
 * @property {number}    dataRowCount
 * @property {Array<{row:number, level?:string}>} sections
 * @property {Array<{row:number}>}                 headers
 * @property {{ gridRows: number, gridColumns: number, chartIds: number[], hidden: boolean, sheetCount: number }} sheet
 *   Grid size after this render's resize, the tab's existing chart ids, whether
 *   it is hidden now, and how many tabs the spreadsheet has.
 * @property {any[]}     cfRules       ConditionalFormatRule objects; core installs them in order.
 * @property {string[]}  warnings      Behaviour the API can't reproduce exactly; reported once per publish.
 */

/**
 * @typedef {Object} PrimitiveSpec
 * @property {string}                              name        Unique; the handler becomes sk_<name>_.
 * @property {string|null}                         [field]     Manifest tab field that triggers inclusion (null = always render).
 * @property {number}                              [order]     Render order, lower first (default 50).
 * @property {(value:any, columns:Set<string>, tab:any)=>string} [validate]  Schema check for this field; "" when valid.
 * @property {(ctx:RenderCtx)=>void}               render      Apps Script behaviour, serialised into the bundle.
 * @property {(ctx:ApiCtx)=>object[]}              requests    The same behaviour as Sheets API batchUpdate requests
 *   (runs in Node). Conditional-format rules go on ctx.cfRules instead, as render does.
 * @property {(ctx:RenderCtx)=>any}                [inputs]    Everything render READS other than cell values (spec
 *   fields, dims, section rows, label-match bitmaps). Core hashes it per tab; the step re-runs only when it changes.
 *   Omit = conservative: any layout change re-runs it. Must not touch ctx.sheet.
 * @property {"format"|"cf"|"sheet"|"chart"}       [region]    What render writes. format = cell formats on the grid
 *   (re-run as a group behind one clearFormat); cf = conditional-format rules (installed atomically as a group);
 *   sheet = sheet-level props (independent); chart = embedded charts. Omit = a dirty step forces a full render.
 */

/**
 * @typedef {Object} Primitive
 * @property {string}      name
 * @property {string|null} field
 * @property {number}      order
 * @property {string}      fn        Handler function name in the bundle (sk_<name>_).
 * @property {(value:any, columns:Set<string>, tab:any)=>string} validate
 * @property {(ctx:ApiCtx)=>object[]} requests  Sheets API behaviour (Node).
 * @property {string}      runtime   Apps Script source: `var sk_<name>_ = <render>;`
 */

/**
 * Normalise a primitive spec into a {@link Primitive}: derive the handler name,
 * keep validate callable in Node, and serialise render into emittable source.
 * @param {PrimitiveSpec} spec
 * @returns {Primitive}
 */
export function definePrimitive(spec) {
  if (!spec || typeof spec.name !== "string" || !spec.name) {
    throw new Error("definePrimitive: name is required");
  }
  if (typeof spec.render !== "function") {
    throw new Error(`definePrimitive(${spec.name}): render must be a function`);
  }
  if (typeof spec.requests !== "function") {
    throw new Error(`definePrimitive(${spec.name}): requests must be a function`);
  }
  const fn = `sk_${spec.name}_`;
  return {
    name: spec.name,
    field: spec.field ?? null,
    order: spec.order ?? 50,
    fn,
    validate: spec.validate ?? (() => ""),
    requests: spec.requests,
    runtime: [
      `var ${fn} = ${spec.render.toString()};`,
      spec.inputs ? `${fn}.inputs = ${spec.inputs.toString()};` : "",
      spec.region ? `${fn}.region = ${JSON.stringify(spec.region)};` : "",
    ].filter(Boolean).join("\n"),
  };
}
