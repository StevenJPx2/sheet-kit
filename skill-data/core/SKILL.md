---
name: core
description: Render Google Sheets from a manifest + data with the `sheet-kit` CLI — validate, compile/deploy the Apps Script renderer, publish data, inspect live sheets. Use when writing a sheet-kit manifest (columns, formulas, gradients, headings), wiring the webhook, or when a sheet renders stale or wrong structure.
allowed-tools: Bash(sheet-kit:*)
---

# sheet-kit

`sheet-kit` renders a Google Sheet from two JSON inputs and knows nothing about
your domain (GA4, merchants, experiments): every value arrives through the
manifest/data contract. A caller composes `manifest.json` + `data.json`;
sheet-kit compiles a generic Apps Script renderer, publishes data, and inspects
live sheets.

- **manifest.json** — tab **structure**: columns (with `source_field` or a
  name-based `formula`), plus styling primitives (gradients, headings,
  number_formats, freeze, charts, merges).
- **data.json** — `{ datasets: { <data_key>: [rows] } }`, the cell **values**.

Load the command + manifest reference before writing a manifest:

```bash
sheet-kit skills get core --full
```

## The render model — where structure vs data lives

The webhook Apps Script renders from a manifest **embedded at compile time**
(`compile` bakes `SHEETKIT_MANIFEST` into the deployed script). `publish` stages
**only `data.json`** to Drive and triggers a re-render against that embedded
manifest.

So: **a manifest/structure change reaches the sheet only through `compile` +
`deploy`, never through `publish` alone.** Data-only changes publish directly.

## Workflows

```bash
sheet-kit validate --manifest manifest.json --data data.json   # contract check
sheet-kit compile  --artifacts DIR --out project/              # manifest → Apps Script
sheet-kit deploy   --project project/ --script-id ID --deployment-id ID
sheet-kit publish  --artifact DIR --config webhook.json --expected-latest 2026-09-12
sheet-kit inspect  --config webhook.json --sheet "Tab" --range A1:A40 --cells
```

**Change structure** (columns, formulas, gradients, headings) → `compile` +
`deploy` the same `--deployment-id`, then `publish` to re-render. **Redeploy the
same deployment id** — that's what the webhook URL (`/macros/s/<id>/exec`)
points at; a fresh deployment gets a new URL.

**Config file** for publish/inspect is `{ url, secret, driveDir }`; pass
`--config -` to read it from stdin (keeps the secret out of argv).

## Formulas are name-based, resolved per row

A column `formula` references other columns by name: `=IFERROR({Revenue}/{Sessions},"")`.
At render each `{ColName}` becomes that column's A1 cell **on the formula's own
row** (`resolveFormula_`), so the manifest never writes A1 and can't drift.

- **Banner** (`banner` on the tab) resolves against the first data row — used for
  a header statement that reads a specific cell (e.g. a cumulative-row p-value).
- **A section heading that is a formula** (a `__section__` value starting `=`)
  resolves against that **block's next data row**, so stacked blocks each get a
  header reading their own cumulative row.

## Gotchas (the ones no --help confesses)

- **Structure change ⇒ compile + deploy.** `publish` stages data only; the
  webhook renders from the embedded manifest.
- **`--expected-latest` gates on the max date in data, not content.** A
  structure-only or same-day change can render the previous Drive file during a
  **sync lag** — publish confirms only that the date is present. Wait ~20s and
  re-publish if the render looks stale.
- **Publish requires exactly one dataset** in `data.json`; the staleness
  handshake retries until Drive syncs the file whose latest `YYYY-MM-DD` ≥
  `--expected-latest`.
- **`gradient.group_by`** splits a column into independent color scales per
  contiguous run of that column's value — use it for stacked sub-tables that
  otherwise share (and wash out) one scale.
- **`heading` levels**: a data row with `__section__` + `__level` renders as a
  merged, styled band; `__header__` re-emits the column headers (a new
  sub-table). Styles come from the manifest's `headings` map.
- **`deploy` uses `clasp`.** Get `--script-id` from `npx @google/clasp list`;
  `--deployment-id` is the exec-URL segment.
