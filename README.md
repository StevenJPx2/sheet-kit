# sheet-kit

Domain-agnostic Google Sheets toolkit. Render a manifest + data directly through
the Sheets API, inspect live spreadsheets, and compare copies. It knows nothing
about GA4, Raven, merchants, or reports. Plain Node ≥24, zero runtime dependencies.

Part of the four-repo performance-reporting split — see
`ga4-querinator/docs/ARCHITECTURE-IDEATION.md`. Dependency direction:
`mpd → {ga4-querinator, jiraiya, sheet-kit}`. sheet-kit is a leaf: it never
imports a source or MPD.

## Google sign-in

One-time setup:

```sh
sheet-kit auth login
# Optional account hint and enforced domain:
sheet-kit auth login --account you@company.com --expect-domain company.com
```

Sign-in uses Google's Gemini CLI Workspace extension login service, following
doc-kit's design but with sheet-kit's own token. No Cloud project, OAuth client,
client.json, secret, PKCE setup, or API-enabling steps are needed. The only scope
is Google Drive (`https://www.googleapis.com/auth/drive`), which covers Sheets
reads/writes and Drive `about` for the account email. The login service exchanges
and refreshes tokens; Google receives the consent request.

- Tokens live in `~/.config/sheet-kit/token.json` (private directory/file modes
  0700/0600); override with `SHEET_KIT_CONFIG_DIR`.
- `auth status` shows the account and credential source. `auth logout` revokes
  and deletes the local token. It does not unset environment secrets.
- `auth login --no-browser` prints a URL but still waits for a loopback callback
  on this machine. `--paste` instead accepts the Credentials JSON shown by the
  service; paste it and press Ctrl-D.
- `SHEET_KIT_EXPECT_DOMAIN` supplies the login domain guard when the flag is
  omitted. A mismatched account's grant is revoked, not saved.
- For cron, run `sheet-kit auth export-env` on the signed-in machine and store
  its stdout, `SHEET_KIT_REFRESH_TOKEN=…`, as a secret on the host. That variable
  alone is enough; no client id, client secret, or token file is needed.
  Diagnostics go to stderr. Never commit the exported secret.
- Credential priority: `SHEET_KIT_ACCESS_TOKEN`, local token file (auto-refreshed),
  then `SHEET_KIT_REFRESH_TOKEN`. A revoked/expired refresh grant requires login
  again and updating exported secrets.
- Advanced overrides: `SHEET_KIT_CLIENT_ID` and `SHEET_KIT_LOGIN_SERVICE`.
  There is no `SHEET_KIT_CLIENT_SECRET` or doc-kit client-file fallback.

## Rendering architecture

Each primitive owns validation and Sheets API request generation. Publishing
runs in Node and reads both artifact files on every invocation.

```text
src/
  primitives/*.js     each feature (gradient, chart, freeze, …) as one definePrimitive
                       module: field, schema check, requests(ctx)
  primitives/index.js the registry the renderer + validator walk
  render/             grid/formula logic, request planning and execution, fakes/goldens
  google/             sign-in, authenticated HTTP retries, chunked Sheets client
  utils/              primitive builder, validator, data coverage:
                        define-primitive.js  the typed primitive builder
                        validate.js          core structural checks; delegates field rules to primitives
                        data.js              dataset/coverage checks
  cli/                command layer (publish, inspect, compare, auth, skills)
  types.d.ts          manifest/data contract (types only)
```

All JavaScript with JSDoc types; typecheck with `tsc -p jsconfig.json`. A new
feature is one file in `src/primitives/` added to the registry — no change to the
renderer, the validator, or any other primitive. Each source directory has a
README with its boundaries and usage examples.

## Adding a primitive

```js
import { definePrimitive } from "../utils/define-primitive.js";

export default definePrimitive({
  name: "gradient",
  field: "gradients",       // manifest field that selects the step (null = always)
  order: 30,                // render order
  validate(gradients, columns) { /* schema check for this field; "" if ok */ },
  requests(ctx) { return []; /* Node behaviour: Sheets batchUpdate requests */ },
});
```

`validate` and `requests` run in Node. Primitives import pure layout helpers
from `render/grid.js`; conditional rules accumulate on `ctx.cfRules` and are
installed in order after the primitive requests.

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
sheet-kit publish  --artifact DIR [--expected-latest DATE]
sheet-kit inspect  --spreadsheet-id ID [--sheet NAME] [--range A1] [--cells]
sheet-kit compare  --spreadsheet-id A --against B [--sheet NAME]
sheet-kit version
```

`publish` reads **both** files from DIR and renders into `manifest.spreadsheet_id`.
Structure changes need only another publish. Renders are always full:
normally four calls for all tabs, plus
one read if preserving user columns, with large writes split near 1.5 MB. API
429/5xx responses use bounded exponential backoff. There is no Drive staging.

`--expected-latest YYYY-MM-DD` is a local safety guard: the newest exact ISO date
string anywhere in the datasets must reach that date. It checks neither content
hashes nor each dataset individually and does not wait for sync.

`inspect` returns tab structure and, with
`--cells`, displayed values, formulas, number formats, backgrounds, font weights,
alignments and wrapping. `--range` selects cell detail; tab extents still describe
the whole tab. `compare` reads both spreadsheets with cells, matches tabs by name,
and returns `{ identical, differences }` with per-tab/per-cell fields. Exit codes:
0 identical, 1 differences or API error, 2 missing flags. Workbook titles and
resource ids are ignored; locale, timezone and tab order are compared.

### Limits

- Grid tests, golden fixtures and an in-memory API cover every primitive,
  first render, re-render, preservation, chart and conditional-rule replacement.
  These are offline tests, not live Google verification.
- Chart `v_axis_format` has no direct API equivalent. Common options (legend,
  axis titles/bounds, series colors/widths, smoothing) are mapped; unsupported
  options warn and are ignored. Custom dash arrays map to a preset dashed line.
- Conditional-format underline is unsupported and warns. Other supported
  compare styles remain. Colors must be hex or supported basic names.
- Compare covers the inspect schema, not every spreadsheet feature: no chart
  specs, dimensions, notes, protections, or full conditional-rule definitions
  (only rule type/ranges). Cell formats are user-entered, not evaluated
  conditional-format appearance; theme-color resolution is not included.

### API-only breaking change

There is no compatibility path. Compile, deploy, clasp, webhook publishing and
webhook inspect have been removed, as have `--config`, `--full` and `--profile`.
Unknown flags fail before any writes. `SHEET_KIT_TRANSPORT` is no longer read.
Callers such as mpd must remove those flags and config piping, supply Google
credentials, and use `publish --artifact DIR` / `inspect --spreadsheet-id ID`.
The artifact contract remains v1. Existing deployed scripts are not modified or
deleted by this change; disabling their triggers/deployments is separate work.
