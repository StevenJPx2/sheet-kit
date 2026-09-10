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

## Usage

```sh
sheet-kit validate --manifest manifest.json [--data data.json]
sheet-kit publish  --manifest manifest.json --data data.json   # not yet implemented
sheet-kit version
```

`validate` checks manifest invariants (contract version, one value source per
column, every referenced column name resolves) and, with `--data`, that every
tab's dataset is present.

## Status

Skeleton. Contract + validation are wired and tested. The publish path (A1
formula resolution, formatting/gradients/charts, atomic Drive write, webhook
import + staleness handshake, Apps Script deploy tooling) is stubbed — it lands
with the `apps-script/` move out of `ga4-querinator`.

```sh
go test ./...
go build ./cmd/sheet-kit
```
