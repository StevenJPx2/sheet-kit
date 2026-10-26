# Contract validation

These modules support the CLI and renderer without importing domain/report code.
The shared external contract lives in `../types.d.ts`; function-specific types
stay beside their owner.

- `define-primitive.js`: `PrimitiveSpec`, normalized `Primitive` and the per-tab
  `ApiCtx`. Requires request generation; defaults optional validation to no-op.
- `validate.js`: contract version, manifest/tab/column invariants and delegation
  to primitive-owned validators. Returns an error string or `""`.
- `data.js`: data contract version/dataset presence and tab-to-dataset coverage.

```js
import { validate } from "./validate.js";
import { validateData, checkCoverage } from "./data.js";

const error = validate(manifest) || validateData(data) || checkCoverage(manifest, data);
if (error) throw new Error(error);
```

Validate before obtaining credentials or rendering. This layer does not compile
code, deploy resources, or perform network requests.
