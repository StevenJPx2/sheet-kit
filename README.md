# sheet-kit

Domain-agnostic Google Sheets toolkit. It owns the manifest contract, styling
and formula primitives, Apps Script generation, publishing, and inspection.
It knows nothing about GA4, Raven, merchants, or reports.

Part of the four-repo performance-reporting split — see
`ga4-querinator/docs/ARCHITECTURE-IDEATION.md`. Dependency direction:
`mpd → {ga4-querinator, jiraiya, sheet-kit}`. sheet-kit is a leaf: it never
imports a source or MPD.

## Contract (v1)

Two files travel together as the artifact:

- `manifest.json` — resolved sheet spec: tabs, typed columns, name-based derived
  formulas, freeze rows/cols, header merges, section-row rules, gradients, line
  charts. Schema: [`contract/manifest.schema.json`](contract/manifest.schema.json).
- `data.json` — canonical rows keyed by dataset. Schema:
  [`contract/data.schema.json`](contract/data.schema.json).

`manifest.tabs[].data_key` joins each tab to `data.datasets[key]`. Columns
reference row fields by `source_field`, or derive values with a name-based
`formula` (`={Revenue}/{Sessions}`) — sheet-kit resolves `{Name}` to A1 refs at
render time, which kills the off-by-one A1-letter bug class.

Contract version lives in [`contract/VERSION`](contract/VERSION) and is enforced
on both files.

## Ownership

MPD declares which sheet-kit primitives a report uses. sheet-kit implements
their behavior and compiles resolved manifests into an Apps Script project.
The checked-in Apps Script contains only generic primitives and transport code;
the generated `manifest.gs` is the application-specific output.

## Manifest scope discipline

Cap the manifest at primitives a real sheet actually uses. Add a primitive only
when a live report needs it. Do not grow this into a general Sheets DSL.

## Build & test

sheet-kit is a plain TypeScript CLI run on Node 24+ — no build step, no compiled
artifact. Node strips types natively, so `src/cli.ts` runs directly (it has a
shebang and is the package `bin`). Node is already required here for `clasp`, so
there's no extra runtime. The renderer is Apps Script (`apps-script/`); the CLI
is the only host-side code.

```sh
npm install                  # @types/node + typescript (dev only)
node --test src/*.test.ts    # unit tests
npx tsc --noEmit             # typecheck
./src/cli.ts version         # run directly
```

Optional: `npm run build` compiles a standalone native binary with
[scriptc](https://github.com/vercel-labs/scriptc) for a host without Node — but
its ~800 KB runtime floor makes it a larger artifact than the ~13 KB of source,
so the default deploy is just the TS on Node. Keep the CLI free of npm runtime
deps (validation is hand-written against the JSON Schema, not `ajv`) so the
scriptc escape hatch stays 100% static.

## Usage

```sh
sheet-kit validate --manifest manifest.json [--data data.json]
sheet-kit compile  --artifacts mpd/out --out generated/apps-script
sheet-kit deploy   --project generated/apps-script --script-id ID [--deployment-id ID]
sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
sheet-kit inspect  --config webhook.json --spreadsheet-id ID [--sheet NAME] [--range A1] [--cells]
sheet-kit version
```

`validate` checks manifest invariants (contract version, one value source per
column, every referenced column name resolves) and, with `--data`, that every
tab's dataset is present. `publish` stages `manifest.json` + `data.json` from
`--artifact` into the mounted Drive folder (`config.driveDir`) and POSTs the
generic webhook with the Drive-sync staleness retry loop.

`compile` validates every artifact below `--artifacts`, combines its tabs, and
emits `sheetkit.gs`, `webhook.gs`, `manifest.gs`, and `appsscript.json`. `deploy`
owns the clasp push/deployment step. The generated webhook embeds the sheet definition;
daily publishes only supply changing data.

`inspect` uses the authenticated generated webhook to read spreadsheet and tab
metadata. `--cells` also returns displayed values, formulas, number formats,
backgrounds, font weights, and horizontal alignments for the requested range.
It does not depend on private Sheets web endpoints or browser cookies.
