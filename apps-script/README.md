# apps-script — generic renderer

The domain-agnostic rendering layer. No merchant, metric, or report names appear
here — every styling decision arrives as manifest data.

- `sheetkit.js` — primitive library + `renderTab(spreadsheet, tabSpec, values)`.
  Primitives: table write, header merges, freeze, number formats, percentile/
  number gradients, text-equals rules, content-driven row-label styling, column
  widths, line charts, A1 letter resolution.
- `webhook.js` — generic `doPost`: authenticates a token, reads `manifest.json`
  + `data.json` from Drive, renders every tab via `renderTab`. No per-report
  functions — a new sheet needs zero webhook change.
- `*.test.cjs` — Node checks for the pure logic (A1 resolver, name→index,
  label matching, row→grid mapping). Run: `node sheetkit.test.cjs`.

## Deploy

`clasp push` from this directory (`.clasp.json` holds the script id). Set the
webhook secret as a Script Property `SHEETKIT_SECRET_HASH` (sha256 of the token).

## Adding a styling primitive

1. Add the primitive fn to `sheetkit.js` and dispatch it in `renderTab`.
2. Add its field to `../contract/manifest.schema.json` and the Go structs in
   `../internal/manifest/manifest.go`.
3. `data` emits the field in a report config; nothing else changes.
