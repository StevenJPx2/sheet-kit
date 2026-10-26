# Styling primitives

Each module owns one feature's manifest validation and Sheets API requests.
There is one implementation per feature; none is serialized to another runtime.

- `index.js`: the authoritative registry and ordered `usedPrimitives(tabs)`.
  Selection is manifest-wide; a selected step runs on each tab, allowing chart
  replacement to clear a tab whose chart list is now empty.
- `header`, `heading`, `numberFormat`, `rowLabel`: cell formatting and merges.
- `gradient`, `textRule`, `compareStyle`: ordered conditional rules accumulated
  on `ctx.cfRules` and installed by the renderer.
- `freeze`, `columnWidth`, `placement`: tab/dimension properties.
- `chart`: chart replacement, source ranges, placement and supported options.

Add a module to the registry; the validator and renderer discover it there.
Pure grid/layout functions belong in `../render/grid.js`; API request builders
belong in `../render/requests.js`. `ApiCtx` is owned by the primitive contract in
`../utils/define-primitive.js`.

```js
import { usedPrimitives } from "./index.js";

const names = usedPrimitives(manifest.tabs).map((primitive) => primitive.name);
```

Tests cover registry ordering, placement, every primitive in render goldens,
and repeated renders without duplicate charts or conditional rules.
