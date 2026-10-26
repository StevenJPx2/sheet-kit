// Representative manifests: together they exercise every primitive (header,
// heading, numberFormat, gradient incl. group_by and MIN/MAX endpoints,
// textRule, compareStyle, rowLabel, freeze, columnWidth, chart incl. the
// stacked-tab options, placement) and the core behaviours (2-row headers +
// merges, banner formula, formula columns, __section__ / __level / formula
// headings, __header__ sub-tables, auto_header:false, string columns, preserve).

/** @returns {import("../../types.js").Manifest} */
export function manifest() {
  return {
    contract_version: 1,
    spreadsheet_id: "SHEET",
    tabs: [
      {
        name: "Daily",
        data_key: "daily",
        header_row: 3,
        banner: { text: '=IF({CVR}>0.02,"Above target","Below target")', level: "significance" },
        headings: { significance: { bold: true, background: "#FFF2CC", align: "center" } },
        columns: [
          { name: "Date", header: "Date", type: "date", source_field: "date", bold: true },
          { name: "Status", header: "", type: "string", source_field: "status" },
          { name: "Sessions", header: "Sessions", type: "integer", source_field: "sessions" },
          { name: "Revenue", header: "Revenue", type: "money", source_field: "revenue" },
          { name: "RPV", header: "RPV", type: "money", formula: '=IFERROR({Revenue}/{Sessions},"")' },
          { name: "CVR", header: "CVR", type: "percent", source_field: "cvr" },
          { name: "Prev CVR", header: "Prev CVR", type: "string", source_field: "prev_cvr" },
        ],
        header_merges: [{ from: "Sessions", to: "RPV", label: "Traffic" }],
        freeze: { rows: 3, cols: 1 },
        number_formats: [{ column: "Revenue", format: "$#,##0.00" }, { column: "CVR", format: "0.00%" }, { column: "Date", format: "yyyy-mm-dd" }],
        column_widths: [{ column: "Date", width: 220 }, { column: "Status", width: 40 }],
        gradients: [
          { column: "RPV", kind: "percentile", min_color: "#ea4335", mid_color: "#ffffff", max_color: "#38aa56" },
          { column: "Sessions", kind: "number", min_kind: "min", max_kind: "max" },
          { column: "Revenue", kind: "percentile", group_by: "Status" },
        ],
        text_rules: [{ equals: "🔴", color: "#f4cccc" }],
        compare_style: [{ a: "CVR", b: "Prev CVR", style: { bold: true, font_color: "#137333" } }],
        row_label_styles: [
          { match: { column: "Date", suffix: "cumulative" }, style: { bold: true, background: "#d9eaf7" } },
          { match: { column: "Date", empty: true }, style: { row_height: 8 } },
          { match: { column: "Date", prefix: "Total" }, style: { merge: true, font_color: "#ffffff", background: "#000", font_size: 12 } },
        ],
        charts: [{ type: "line", title: "CVR", x: "Date", series: ["CVR", "Prev CVR"], colors: ["#4285f4", "#db4437"], position: { row: 2, col: 9 }, options: { "legend.position": "bottom" } }],
        placement: { position: "first" },
      },
      {
        name: "Stacked",
        data_key: "stacked",
        auto_header: false,
        header_row: 1,
        headings: {
          title: { bold: true, font_size: 14, row_height: 30 },
          period: { italic: true, background: "#eef5fb", merge: false },
          chart: { row_height: 300 },
          header: { bold: true, background: "#e8eef2", merge: false, align: "center" },
        },
        columns: [
          { name: "Key", header: "Key", type: "string", source_field: "key" },
          { name: "Value", header: "Value", type: "number", source_field: "value" },
        ],
        charts: [{ type: "line", x: "Key", series: ["Value"], data_from_last_header: true, anchor_section: "chart", hide_data: true, num_headers: 1, position: { col: 5 } }],
        placement: { position: "last", hidden: true },
      },
      {
        name: "Log",
        data_key: "log",
        row_key: "Date",
        columns: [
          { name: "Date", header: "Date", type: "string", source_field: "date" },
          { name: "Orders", header: "Orders", type: "integer", source_field: "orders" },
          { name: "Notes", header: "Notes", type: "string", preserve: true },
        ],
      },
    ],
  };
}

/** @returns {import("../../types.js").Data} */
export function data({ revenue = 100 } = {}) {
  return {
    contract_version: 1,
    datasets: {
      daily: [
        { date: "Rolling 7 days cumulative", status: "🟢", sessions: 700, revenue: revenue * 7, cvr: 0.021, prev_cvr: "1.90%" },
        { date: "2026-09-14", status: "🟢", sessions: 100, revenue, cvr: 0.02, prev_cvr: "2.10%" },
        { date: "2026-09-13", status: "🔴", sessions: 90, revenue: revenue - 10, cvr: 0.018, prev_cvr: "1.70%" },
        { date: "" },
        { date: "Total", sessions: 790 },
      ],
      stacked: [
        { __section__: "Weekly report", __level: "title" },
        { __section__: '=IF({Value}>1,"up","down")', __level: "period" },
        { __header__: true },
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { __section__: "Chart", __level: "chart" },
        { __header__: true },
        { key: "2026-09-13", value: 3 },
        { key: "2026-09-14", value: 4 },
      ],
      log: [
        { date: "2026-09-14", orders: 12 },
        { date: "2026-09-13", orders: 9 },
      ],
    },
  };
}
