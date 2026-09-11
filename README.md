# sheet-kit

Domain-agnostic Google Sheets toolkit. It owns the whole Sheets layer — styling
and formula primitives, manifest validation, Apps Script generation, deploy,
publish, and inspection. It knows nothing about GA4, Raven, merchants, or
reports.

Part of the four-repo performance-reporting split — see
`ga4-querinator/docs/ARCHITECTURE-IDEATION.md`. Dependency direction:
`mpd → {ga4-querinator, jiraiya, sheet-kit}`. sheet-kit is a leaf: it never
imports a source or MPD.

## Everything is compiled

There is no hand-maintained Apps Script and no central schema file. A sheet's
Apps Script project is produced entirely by `sheet-kit compile` from the
primitive definitions in `src/`. The compiler includes **only the primitives a
manifest actually uses**, generates the render dispatch, and embeds the manifest.

```text
src/
  primitives/*.js     each feature (gradient, chart, freeze, …) as one definePrimitive
                      module: its manifest field, its schema check, its render behaviour
  primitives/index.js the registry the compiler + validator walk
  runtime/core.js     A1 helpers, formula resolution, preservation, renderTab dispatch
  runtime/webhook.js  generic doPost transport + inspect
  utils/              definePrimitive builder, compiler, validator, data coverage:
                        define-primitive.js  the typed primitive builder
                        compiler.js          assembles core + used primitives + dispatch → *.gs
                        validate.js          core structural checks; delegates field rules to primitives
                        data.js              dataset/coverage checks
  cli/                command layer (cli, publish, deploy)
  types.d.ts          shared shapes + ambient runtime globals (types only)
```

All JavaScript with JSDoc types; typecheck with `tsc -p jsconfig.json`. A new
feature is one file in `src/primitives/` added to the registry — no change to the
compiler, the validator, or any other primitive.

## Adding a primitive

```js
import { definePrimitive } from "../utils/define-primitive.js";

export default definePrimitive({
  name: "gradient",         // handler becomes sk_gradient_
  field: "gradients",       // manifest tab field that triggers inclusion (null = always)
  order: 30,                // render order
  validate(gradients, columns) { /* schema check for this field; "" if ok */ },
  render: function (ctx) {  /* Apps Script behaviour, serialised into the bundle */ },
});
```

`render` is never executed in Node — the compiler serialises it into the bundle,
where it runs against Apps Script + core globals (`columnIndex_`, `gradientRuns_`,
…, declared in `types.d.ts`). `validate` runs in Node at compile/validate time.

## Contract (v1)

Two files travel together as the artifact:

- `manifest.json` — resolved sheet spec: tabs, typed columns, name-based derived
  formulas, freeze, header merges, row-label rules, gradients, charts.
- `data.json` — canonical rows keyed by dataset.

`manifest.tabs[].data_key` joins each tab to `data.datasets[key]`. Columns pull a
row field via `source_field`, or derive a value with a name-based `formula`
(`={Revenue}/{Sessions}`) — the runtime resolves `{Name}` to A1 refs per row,
which kills the off-by-one A1-letter bug class.

## Build & test

Plain Node (>=24), no build step, no `dist/`. Node runs the JS directly (the CLI
has a shebang and is the package `bin`).

```sh
npm install     # @types/node + typescript (dev only, for typecheck)
npm test        # node --test
npm run check   # tsc -p jsconfig.json (checkJs over JSDoc)
```

## Usage

```sh
sheet-kit validate --manifest manifest.json [--data data.json]
sheet-kit compile  --artifacts mpd/out --out generated/apps-script [--timezone TZ]
sheet-kit deploy   --project generated/apps-script --script-id ID [--deployment-id ID]
sheet-kit publish  --artifact DIR --config webhook.json [--expected-latest DATE]
sheet-kit inspect  --config webhook.json --spreadsheet-id ID [--sheet NAME] [--range A1] [--cells]
sheet-kit version
```

`compile` validates and combines every artifact below `--artifacts` and emits
`sheetkit.gs` (core + used primitives + dispatch), `webhook.gs`, `manifest.gs`,
and `appsscript.json`. `deploy` owns the clasp push/deployment. The generated
webhook embeds the manifest; daily `publish` runs only stage changing data.
`inspect` reads spreadsheet/tab metadata (and, with `--cells`, values, formulas,
number formats, backgrounds, font weights, alignments) through the authenticated
webhook — no private Sheets endpoints or browser cookies.
