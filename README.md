# sheet-kit

Domain-agnostic Google Sheets rendering framework. Takes a resolved
**manifest** + **data** artifact (emitted by `data`) and publishes it. Knows
nothing about GA4, Raven, or experiments.

Part of the four-repo performance-reporting split — see
`ga4-querinator/docs/ARCHITECTURE-IDEATION.md`. Dependency direction:
`data → {ga4-querinator, jiraiya, sheet-kit}`. sheet-kit is a leaf: it never
imports a source or `data`.

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
sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
sheet-kit version
```

`validate` checks manifest invariants (contract version, one value source per
column, every referenced column name resolves) and, with `--data`, that every
tab's dataset is present. `publish` stages `manifest.json` + `data.json` from
`--artifact` into the mounted Drive folder (`config.driveDir`) and POSTs the
generic webhook with the Drive-sync staleness retry loop.
