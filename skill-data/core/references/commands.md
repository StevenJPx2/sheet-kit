# sheet-kit command + manifest reference

## Commands

```
sheet-kit validate --manifest M.json [--data D.json]
sheet-kit auth login [--account EMAIL] [--expect-domain D] [--no-browser] [--paste]
sheet-kit auth status | export-env | logout
sheet-kit publish  --artifact DIR [--expected-latest DATE]
sheet-kit inspect  --spreadsheet-id ID [--sheet NAME] [--range A1] [--cells]
sheet-kit compare  --spreadsheet-id A --against B [--sheet NAME]
sheet-kit skills get core [--full]
sheet-kit version
```

`--artifact` takes a directory containing `manifest.json` + `data.json`.
Publish applies both structure and data immediately; always full.
`--expected-latest YYYY-MM-DD` locally rejects data
whose newest exact ISO date value (across all datasets) is older or absent.
This is not a content hash or a per-dataset freshness check.

## Google sign-in and host environment

Run `sheet-kit auth login` once. Google's Gemini CLI Workspace extension login
service handles token exchange/refresh. Single scope: Google Drive, also valid
for Sheets reads/writes. No Cloud project, client.json, client secret, PKCE, or
API-enabling steps. `--account` is a hint; `--expect-domain` checks the returned
email and revokes/discards mismatches. `--no-browser` still uses this machine's
loopback callback; `--paste` reads the service's Credentials JSON until Ctrl-D.

- `SHEET_KIT_CONFIG_DIR`: default `~/.config/sheet-kit`, containing `token.json`.
- Credential priority: `SHEET_KIT_ACCESS_TOKEN` (one-off), local token
  (auto-refresh), then `SHEET_KIT_REFRESH_TOKEN` (fileless host).
- `SHEET_KIT_EXPECT_DOMAIN`: default login domain guard.
- `SHEET_KIT_CLIENT_ID`, `SHEET_KIT_LOGIN_SERVICE`: advanced service overrides.
- `auth export-env`: stdout is only `SHEET_KIT_REFRESH_TOKEN=…`; diagnostics use
  stderr. Keep this secret. A cron host needs only this variable, no client files.
- `auth status`: account and source; `auth logout`: revoke/delete local token.
  It does not unset host environment secrets. On `invalid_grant`, log in again
  and replace exported secrets.

## Inspect and compare

Inspect returns workbook id/name/locale/timezone and tabs' name/id/hidden,
content rows/columns, frozen counts, merges and conditional-rule type/ranges.
`--cells` adds displayed values, formulas, number_formats, backgrounds,
font_weights, horizontal_alignments, wrap_strategies, and the selected A1 range.
`--range` slices cells only, not the whole-tab extents. Without a range, it reads
the content extent (A1 for an empty tab).

Compare reads both workbooks with cells, optionally one named tab, and returns
`{ identical, differences: [{ sheet?, cell?, field, left, right }] }`. Workbook
titles and resource ids are ignored. Tab order, locale/timezone, structure and
cell fields are compared; exit 0 identical, 1 differences/error, 2 missing flags.
It does not compare charts, dimensions, notes, protections or full conditional
rules. Formats are user-entered, not evaluated conditional appearance, and theme
colors are not resolved. Both commands are read-only.

## Removed commands and flags

Only the Sheets API is supported. Compile/deploy and webhook config/transport
are removed. `--config`, `--full` and `--profile` fail as unknown flags before
any writes. `SHEET_KIT_TRANSPORT` is not read. Callers must use the commands
above without config piping; credentials come from Google sign-in, not a shared
webhook secret. Previously deployed Apps Scripts/triggers remain untouched.

## Manifest shape (contract v1)

```jsonc
{
  "contract_version": 1,
  "spreadsheet_id": "…",
  "tabs": [{
    "name": "Daily Performance",
    "data_key": "daily",              // selects data.json datasets[data_key]
    "header_row": 2,                  // # header rows (group header + column names)
    "freeze": { "rows": 2, "cols": 1 },
    "placement": { "position": "last", "hidden": false },  // "first"|"last"; hidden absent = leave as is
    "columns": [
      { "name": "Date", "header": "Date", "type": "date", "source_field": "date", "bold": true },
      { "name": "RPV",  "header": "RPV",  "type": "money",
        "formula": "=IFERROR({Revenue}/{Sessions},\"\")" }   // {ColName} → per-row A1
    ],
    "header_merges": [ { "from": "…", "to": "…", "label": "RPV" } ],
    "number_formats": [ { "column": "RPV", "format": "$0.00" } ],
    "gradients": [
      { "column": "CVR", "kind": "number",                    // fixed thresholds
        "min_value": 0.01, "mid_value": 0.02, "max_value": 0.03,
        "min_color": "#ea4335", "mid_color": "#ffffff", "max_color": "#38aa56" },
      { "column": "RPV", "kind": "percentile", "group_by": "Section" }   // per-run scales
    ],
    "headings": { "title": { "bold": true, "background": "#d9eaf7" } },
    "banner": { "text": "=…", "level": "significance" },      // resolves vs first data row
    "row_label_styles": [ … ],
    "charts": [ … ]
  }]
}
```

New tabs are created at the end of the tab bar. Every render reapplies
`placement`; omitting `hidden` preserves a manual hide.

Gradient `kind`: `number` | `percent` | `percentile` | `min` | `max`, with
independent `min_kind`/`mid_kind`/`max_kind`. Heading rows travel in `data.json`
as `{ "__section__": "…", "__level": "title" }` or `{ "__header__": true }`;
their positions come from data, their styles from `headings`.

API chart limits: `v_axis_format` has no direct equivalent, unsupported Charts
options warn/skip, and custom dash patterns use a preset. Conditional underline
warns/skips. Use hex colors or supported basic names. Golden request/sheet tests
cover all primitives; simulation is not live Google verification.

## Runtime layout

`src/cli/cli.js` → `src/cli/{publish,inspect,compare,skills}.js`,
`src/google/{auth,http,sheets}.js`, `src/render/{grid,render,requests}.js`,
`src/utils/{define-primitive,validate,data}.js`, `src/primitives/*.js`
(validation and `requests(ctx)`). See each directory's README for details.
