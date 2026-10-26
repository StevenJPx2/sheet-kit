---
name: core
description: Render Google Sheets from manifest + data through the Sheets API with sheet-kit. Sign in, validate, publish structure and values, inspect live sheets, and compare copies. Also supports legacy compile/deploy/webhook workflows.
allowed-tools: Bash(sheet-kit:*)
---

# sheet-kit

`sheet-kit` renders a Google Sheet from two JSON inputs and knows nothing about
your domain (GA4, merchants, experiments): every value arrives through the
manifest/data contract. A caller composes `manifest.json` + `data.json`;
sheet-kit renders them through the Sheets API as the signed-in Google account.
It also inspects live sheets and compares copies. No runtime dependencies.

- **manifest.json** — tab **structure**: columns (with `source_field` or a
  name-based `formula`), plus styling primitives (gradients, headings,
  number_formats, freeze, charts, merges).
- **data.json** — `{ datasets: { <data_key>: [rows] } }`, the cell **values**.

Load the command + manifest reference before writing a manifest:

```bash
sheet-kit skills get core --full
```

## Sign in once

```bash
sheet-kit auth login
# Optional guard against signing into the wrong account:
sheet-kit auth login --account you@company.com --expect-domain company.com
sheet-kit auth status
```

Uses Google's Gemini CLI Workspace extension login service, like doc-kit, with
sheet-kit's own token and **Drive scope only** (also covers Sheets writes).
No Cloud project, OAuth client/client.json, API-enabling steps, or client secret.

- Token: `~/.config/sheet-kit/token.json`, private 0600; override with
  `SHEET_KIT_CONFIG_DIR`. Access tokens renew automatically.
- `auth login --no-browser` prints a URL but still needs a callback to this
  machine's loopback port. `--paste` accepts the service's Credentials JSON and
  Ctrl-D instead, for remote/headless machines.
- `SHEET_KIT_EXPECT_DOMAIN` defaults the login domain guard; mismatches are
  revoked and not stored.
- Cron: `sheet-kit auth export-env` prints only `SHEET_KIT_REFRESH_TOKEN=…` to
  stdout. Store it as a host secret, never in git. That variable alone signs in.
- Credential order: `SHEET_KIT_ACCESS_TOKEN`, local token, then
  `SHEET_KIT_REFRESH_TOKEN`. `auth logout` revokes/deletes the local token;
  remove environment secrets separately. `invalid_grant` requires login again.

## Render model

`publish --artifact DIR` reads **manifest.json and data.json** each time and
renders into the manifest's spreadsheet id. Structure and data changes both
take effect on the next publish. **No compile or deploy is needed.** Every API
render is full; `--full` is accepted for compatibility. Normally four calls for
the whole workbook, plus one read for preserved columns; large writes chunk.

## Workflows

```bash
sheet-kit validate --manifest manifest.json --data data.json   # contract check
sheet-kit publish  --artifact DIR --expected-latest 2026-09-12
sheet-kit inspect  --spreadsheet-id ID --sheet "Tab" --range A1:A40 --cells
sheet-kit compare  --spreadsheet-id A --against B --sheet "Tab"
```

Compare returns JSON `{ identical, differences }`, with tab names, A1 cells,
fields and left/right values. Exit 0 identical, 1 differences/API error, 2 missing
flags. Ignores workbook titles and resource ids; compares tab order, locale,
timezone, structure and inspect cell fields. It does not compare chart specs,
dimensions, or full conditional-rule definitions (only type/ranges).

## Legacy migration (deprecated but working)

- `publish --config webhook.json` uses the old Apps Script webhook. Config is
  `{ url, secret }`; `--config -` reads stdin. `driveDir` is ignored with a note;
  data always travels inline, never via Drive sync.
- Set `SHEET_KIT_TRANSPORT=api` to migrate an existing `--config` caller without
  changing its invocation. The webhook config is then ignored (not read).
- Legacy structure changes still require `compile --artifacts DIR --out project/`
  then `deploy --project project/ --script-id ID --deployment-id ID`, then publish.
  **Deploy stays on clasp**, with its separate login. Keep the same deployment
  id to preserve the webhook URL. API publishing needs none of this.
- Inspect uses the API with `--spreadsheet-id` and sign-in; `--config` remains
  the webhook fallback without an id/sign-in. The output shape is unchanged.

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

- **API publish applies structure immediately.** Compile/deploy is only for
  the deprecated webhook path, whose manifest is embedded.
- **`--expected-latest` is a local guard**, not a sync handshake: refuse if the
  newest exact `YYYY-MM-DD` value anywhere in the datasets is older. It does not
  validate content or freshness of each dataset separately. Multiple datasets work.
- **API parity limits:** chart `v_axis_format`, unsupported Google Charts
  options, and conditional underline warn and are skipped. Custom dash patterns
  use a preset. Inspect reports user-entered formats, not conditional appearance;
  theme colors aren't resolved. Offline parity tests are not live Google proof.
- **`gradient.group_by`** splits a column into independent color scales per
  contiguous run of that column's value — use it for stacked sub-tables that
  otherwise share (and wash out) one scale.
- **`heading` levels**: a data row with `__section__` + `__level` renders as a
  merged, styled band; `__header__` re-emits the column headers (a new
  sub-table). Styles come from the manifest's `headings` map.
- **Publish rewrites rendered tabs** (including their formatting, charts and
  conditional rules); use preserve columns keyed by `row_key` for user notes.
  Inspect/compare are read-only. Do not publish to production just to inspect it.
