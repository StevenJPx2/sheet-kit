# sheet-kit command + manifest reference

## Commands

```
sheet-kit validate --manifest M.json [--data D.json]
sheet-kit compile  --artifacts DIR --out DIR [--timezone TZ]
sheet-kit deploy   --project DIR [--script-id ID] [--deployment-id ID] [--description TEXT]
sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
sheet-kit inspect  --config webhook.json [--spreadsheet-id ID] [--sheet NAME] [--range A1] [--cells]
sheet-kit skills get core [--full]
sheet-kit version
```

`--config -` reads the webhook config from stdin. `--artifacts` (compile) takes a
directory of per-report artifact folders; `--artifact` (publish) takes one.

## Webhook config

```json
{ "url": "https://script.google.com/macros/s/<deploymentId>/exec",
  "secret": "<raw webhook secret>",
  "driveDir": "~/…/My Drive" }
```
`publish` copies `data.<datasetKey>.json` into `driveDir`, then POSTs
`{token, data, expectedLatest}`; the Apps Script hashes the token against the
`SHEETKIT_SECRET_HASH` script property.

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

New tabs are created at the end of the tab bar. `placement` is re-applied when
it changes and on every full render, so a manual move or unhide sticks until then.

Gradient `kind`: `number` | `percent` | `percentile` | `min` | `max`, with
independent `min_kind`/`mid_kind`/`max_kind`. Heading rows travel in `data.json`
as `{ "__section__": "…", "__level": "title" }` or `{ "__header__": true }`;
their positions come from data, their styles from `headings`.

## Deploy

```bash
sheet-kit compile --artifacts ./out --out ./project
sheet-kit deploy  --project ./project --script-id <ID> --deployment-id <ID>
```
`deploy` writes `.clasp.json`, `clasp push --force`, then `clasp deploy`
(re)using `--deployment-id` so the webhook URL keeps serving the new code.
First generic deploy: set the `SHEETKIT_SECRET_HASH` script property (sha256 of
the webhook secret).

## Runtime layout

`src/cli/cli.js` (dispatch) → `src/cli/{deploy,publish,skills}.js`,
`src/utils/{compiler,validate,data}.js`, `src/runtime/{core,webhook}.js`
(the Apps Script bundle), `src/primitives/*.js` (one file per styling
primitive, self-validating).
