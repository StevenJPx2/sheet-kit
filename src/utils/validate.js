// Manifest validation. Core structural rules live here; every field-specific
// rule is owned by the primitive that renders that field and reached through the
// PRIMITIVES registry — there is no central schema to keep in sync.

import { PRIMITIVES } from "../primitives/index.js";

export const CONTRACT_VERSION = 1;

const COLUMN_TYPES = new Set(["string", "number", "integer", "money", "percent", "date", "hour"]);

/**
 * Extract {ColumnName} references from a name-based formula.
 * @param {string|undefined} formula
 * @returns {string[]}
 */
export function formulaRefs(formula) {
  if (!formula) return [];
  const refs = [];
  let rest = formula;
  for (;;) {
    const open = rest.indexOf("{");
    if (open < 0) break;
    const close = rest.indexOf("}", open);
    if (close < 0) break;
    refs.push(rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
  return refs;
}

/**
 * Validate a parsed manifest; returns an error message or "" when valid.
 * @param {import("../types.js").Manifest} m
 * @returns {string}
 */
export function validate(m) {
  if (m.contract_version !== CONTRACT_VERSION) {
    return `contract_version ${m.contract_version} unsupported (this build speaks ${CONTRACT_VERSION})`;
  }
  if (!m.spreadsheet_id) return "spreadsheet_id is required";
  if (!m.tabs || m.tabs.length === 0) return "manifest has no tabs";

  const tabNames = new Set();
  const dataKeys = new Set();
  for (const tab of m.tabs) {
    if (tabNames.has(tab.name)) return `duplicate tab name ${JSON.stringify(tab.name)}`;
    if (dataKeys.has(tab.data_key)) return `duplicate data_key ${JSON.stringify(tab.data_key)}`;
    tabNames.add(tab.name);
    dataKeys.add(tab.data_key);

    const err = validateTab(tab);
    if (err) return `tab ${JSON.stringify(tab.name)}: ${err}`;
  }
  return "";
}

/** @param {import("../types.js").Tab} t */
function validateTab(t) {
  if (!t.name) return "name is required";
  if (!t.data_key || !t.data_key.trim()) return "data_key is required";
  if (!t.columns || t.columns.length === 0) return "has no columns";

  const names = new Set();
  for (let i = 0; i < t.columns.length; i++) {
    const c = t.columns[i];
    if (!c.name) return `column ${i}: name is required`;
    if (names.has(c.name)) return `duplicate column name ${JSON.stringify(c.name)}`;
    names.add(c.name);
    if (!COLUMN_TYPES.has(c.type)) return `column ${JSON.stringify(c.name)}: invalid type ${JSON.stringify(c.type)}`;
    if (c.source_field && c.formula) {
      return `column ${JSON.stringify(c.name)}: source_field and formula are mutually exclusive`;
    }
  }

  for (const c of t.columns) {
    for (const ref of formulaRefs(c.formula)) {
      if (!names.has(ref)) return `column ${JSON.stringify(c.name)} formula references unknown column ${JSON.stringify(ref)}`;
    }
  }
  if (t.row_key && !names.has(t.row_key)) return `row_key references unknown column ${JSON.stringify(t.row_key)}`;
  if (t.columns.some((column) => column.preserve) && !t.row_key) return "preserved columns require row_key";

  // Field-specific rules are delegated to each primitive's own schema check.
  for (const p of PRIMITIVES) {
    const value = p.field ? t[p.field] : t;
    const err = p.validate(value, names, t);
    if (err) return err;
  }
  return "";
}
