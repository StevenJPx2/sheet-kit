# CLI boundary

`cli.js` owns argument validation, local artifact reads, auth commands, exit
codes and stdout/stderr. Unknown flags are rejected before file or network work.

| Module | Boundary |
| --- | --- |
| `publish.js` | Guard freshness, obtain a token and render validated artifacts. Errors propagate to the CLI. |
| `inspect.js` | Read Sheets metadata/cells and map sparse responses to the public snapshot shape. |
| `compare.js` | Read two snapshots concurrently; report structural and A1 cell differences. |
| `skills.js` | Serve/install version-matched skill documents. |

```sh
sheet-kit auth login
sheet-kit validate --manifest report/manifest.json --data report/data.json
sheet-kit publish --artifact report/
sheet-kit inspect --spreadsheet-id ID --sheet Daily --cells
sheet-kit compare --spreadsheet-id A --against B
```

- Publishing writes. Inspect and compare are read-only.
- Machine-readable results use stdout; diagnostics/warnings use stderr.
- Compare exits 0 when identical, 1 on differences or errors, 2 on missing flags.
- Only direct Sheets API access is supported. No generated project, deployment,
  webhook configuration, shared secret or transport selection exists.

CLI tests run the real Node entry point in child processes with an injected
HTTP adapter; they do not contact Google or change live spreadsheets.
