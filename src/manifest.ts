// sheet-kit render contract (v1): manifest types + Validate, mirroring
// contract/manifest.schema.json. Hand-written validation (no ajv) so the CLI
// stays statically compilable by scriptc into a dependency-free native binary.

export const CONTRACT_VERSION = 1;

export type ColumnType = "string" | "number" | "integer" | "money" | "percent" | "date" | "hour";
export type GradientKind = "number" | "percent" | "percentile" | "min" | "max";

export interface Column {
  name: string;
  type: ColumnType;
  source_field?: string;
  formula?: string;
}

export interface Freeze { rows?: number; cols?: number; }
export interface Merge { from: string; to: string; label: string; }
export interface NumberFormat { column: string; format: string; }
export interface ColumnWidth { column: string; width: number; }
export interface TextRule { equals: string; color: string; }

export interface LabelMatch { column?: string; prefix?: string; suffix?: string; equals?: string; }
export interface RowStyle { bold?: boolean; background?: string; font_color?: string; font_size?: number; merge?: boolean; row_height?: number; }
export interface RowLabelStyle { match: LabelMatch; style: RowStyle; }

export interface Gradient {
  column: string;
  kind: GradientKind;
  min_color?: string; mid_color?: string; max_color?: string;
  min_value?: number | string; mid_value?: number | string; max_value?: number | string;
}

export interface ChartPos { row?: number; col?: number; }
export interface Chart {
  type: "line";
  title?: string;
  x: string;
  series: string[];
  num_headers?: number;
  v_axis_format?: string;
  colors?: string[];
  width?: number; height?: number;
  position?: ChartPos;
}

export interface Tab {
  name: string;
  data_key: string;
  columns: Column[];
  header_row?: number;
  freeze?: Freeze;
  header_merges?: Merge[];
  number_formats?: NumberFormat[];
  row_label_styles?: RowLabelStyle[];
  text_rules?: TextRule[];
  column_widths?: ColumnWidth[];
  gradients?: Gradient[];
  charts?: Chart[];
}

export interface Manifest {
  contract_version: number;
  spreadsheet_id: string;
  tabs: Tab[];
}

const COLUMN_TYPES = new Set<string>(["string", "number", "integer", "money", "percent", "date", "hour"]);
const GRADIENT_KINDS = new Set<string>(["number", "percent", "percentile", "min", "max"]);

/** Extract {ColumnName} references from a name-based formula. */
export function formulaRefs(formula: string | undefined): string[] {
  if (!formula) return [];
  const refs: string[] = [];
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

/** Validate a parsed manifest; returns an error message or "" when valid. */
export function validate(m: Manifest): string {
  if (m.contract_version !== CONTRACT_VERSION) {
    return `contract_version ${m.contract_version} unsupported (this build speaks ${CONTRACT_VERSION})`;
  }
  if (!m.spreadsheet_id) return "spreadsheet_id is required";
  if (!m.tabs || m.tabs.length === 0) return "manifest has no tabs";

  for (const tab of m.tabs) {
    const err = validateTab(tab);
    if (err) return `tab ${JSON.stringify(tab.name)}: ${err}`;
  }
  return "";
}

function validateTab(t: Tab): string {
  if (!t.name) return "name is required";
  if (!t.data_key) return "data_key is required";
  if (!t.columns || t.columns.length === 0) return "has no columns";

  const names = new Set<string>();
  for (let i = 0; i < t.columns.length; i++) {
    const c = t.columns[i];
    if (!c.name) return `column ${i}: name is required`;
    if (names.has(c.name)) return `duplicate column name ${JSON.stringify(c.name)}`;
    names.add(c.name);
    if (!COLUMN_TYPES.has(c.type)) return `column ${JSON.stringify(c.name)}: invalid type ${JSON.stringify(c.type)}`;
    if ((!c.source_field) === (!c.formula)) {
      return `column ${JSON.stringify(c.name)}: exactly one of source_field or formula is required`;
    }
  }

  for (const c of t.columns) {
    for (const ref of formulaRefs(c.formula)) {
      if (!names.has(ref)) return `column ${JSON.stringify(c.name)} formula references unknown column ${JSON.stringify(ref)}`;
    }
  }
  for (const g of t.gradients ?? []) {
    if (!names.has(g.column)) return `gradient references unknown column ${JSON.stringify(g.column)}`;
    if (!GRADIENT_KINDS.has(g.kind)) return `gradient on ${JSON.stringify(g.column)}: invalid kind ${JSON.stringify(g.kind)}`;
  }
  for (const nf of t.number_formats ?? []) {
    if (!names.has(nf.column)) return `number_format references unknown column ${JSON.stringify(nf.column)}`;
  }
  for (const cw of t.column_widths ?? []) {
    if (!names.has(cw.column)) return `column_width references unknown column ${JSON.stringify(cw.column)}`;
  }
  for (const rls of t.row_label_styles ?? []) {
    if (rls.match.column && !names.has(rls.match.column)) return `row_label_style references unknown column ${JSON.stringify(rls.match.column)}`;
  }
  for (const hm of t.header_merges ?? []) {
    if (!names.has(hm.from) || !names.has(hm.to)) return `header_merge references unknown column ${JSON.stringify(hm.from)}/${JSON.stringify(hm.to)}`;
  }
  for (const ch of t.charts ?? []) {
    if (ch.type !== "line") return `chart: unsupported type ${JSON.stringify(ch.type)}`;
    if (!names.has(ch.x)) return `chart references unknown x column ${JSON.stringify(ch.x)}`;
    if (!ch.series || ch.series.length === 0) return `chart ${JSON.stringify(ch.title ?? "")}: no series`;
    for (const s of ch.series) {
      if (!names.has(s)) return `chart references unknown series column ${JSON.stringify(s)}`;
    }
  }
  return "";
}
