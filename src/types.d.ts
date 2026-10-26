// Shared type shapes (the manifest/data contract) and ambient declarations for
// the globals a primitive render body sees inside the compiled Apps Script
// bundle. Implementation is all JavaScript + JSDoc; this file is types only.

export type ColumnType = "string" | "number" | "integer" | "money" | "percent" | "date" | "hour";
export type GradientKind = "number" | "percent" | "percentile" | "min" | "max";

export interface Column {
  name: string;
  header?: string;
  type: ColumnType;
  source_field?: string;
  formula?: string;
  bold?: boolean;
  preserve?: boolean;
}

export interface Freeze { rows?: number; cols?: number; }
export interface Placement { position?: "first" | "last"; hidden?: boolean; }
export interface Merge { from: string; to: string; label: string; }
export interface NumberFormat { column: string; format: string; }
export interface ColumnWidth { column: string; width: number; }
export interface TextRule { equals: string; color: string; }
export interface LabelMatch { column?: string; prefix?: string; suffix?: string; equals?: string; empty?: boolean; }
export interface RowStyle { bold?: boolean; background?: string; font_color?: string; font_size?: number; merge?: boolean; row_height?: number; }
export interface RowLabelStyle { match: LabelMatch; style: RowStyle; }

export interface Gradient {
  column: string;
  kind: GradientKind;
  min_kind?: GradientKind; mid_kind?: GradientKind; max_kind?: GradientKind;
  min_color?: string; mid_color?: string; max_color?: string;
  min_value?: number | string; mid_value?: number | string; max_value?: number | string;
  group_by?: string;
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
  row_key?: string;
  header_row?: number;
  freeze?: Freeze;
  placement?: Placement;
  header_merges?: Merge[];
  number_formats?: NumberFormat[];
  row_label_styles?: RowLabelStyle[];
  text_rules?: TextRule[];
  column_widths?: ColumnWidth[];
  gradients?: Gradient[];
  charts?: Chart[];
  headings?: Record<string, HeadingStyle>;
  auto_header?: boolean;
  banner?: string | { text: string; level?: string };
  [field: string]: unknown;
}

export interface Manifest {
  contract_version: number;
  spreadsheet_id: string;
  tabs: Tab[];
}

export interface HeadingStyle {
  bold?: boolean; italic?: boolean; merge?: boolean;
  background?: string; font_color?: string; font_size?: number;
  align?: "left" | "center" | "right"; row_height?: number;
}

// A data row is metric fields, or a control row: __section__ (merged heading
// text, optional __level) or __header__ (re-emit column headers).
export type Row = Record<string, string | number | boolean | null | undefined>;
export interface Data {
  contract_version: number;
  generated_at?: string;
  datasets: Record<string, Row[]>;
}

// Globals available to every primitive render body (defined by runtime/core.js
// and Google Apps Script) once the compiler concatenates the bundle.
declare global {
  function columnIndex_(columns: any[], name: string): number;
  function columnName_(index: number): string;
  function gradientRuns_(
    values: any[][], columns: any[], firstDataRow: number, dataRowCount: number, groupBy?: string,
  ): Array<{ firstRow: number; rowCount: number }>;
  function matchLabel_(label: string, match: any): boolean;
  function resolveFormula_(formula: string, columns: any[], sheetRow: number): string;

  var SK_RENDER_STEPS: Array<(ctx: any) => void>;
  var SHEETKIT_MANIFEST: any;

  // Apps Script services (loosely typed; runtime-only).
  var SpreadsheetApp: any;
  var Charts: any;
  var Utilities: any;
  var ContentService: any;
  var PropertiesService: any;
}
