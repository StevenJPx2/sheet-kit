# apps-script (placeholder)

The Google Apps Script webhook (atomic Drive import, staleness handshake,
per-action CSV imports) moves here from `ga4-querinator/apps-script/` when the
`sheet-kit publish` path is implemented.

Until then it still lives in `ga4-querinator`. Do not fork it — move it.

Contract the webhook must keep:

- `doPost` authenticates a `token` (sha256 hash compare).
- `expectedLatest` staleness handshake returns `{ ok: false, stale: true }` if
  the imported data is older than the caller's latest date.
- Per-action imports keyed by `action` (daily/hourly/experiment/products/qa/web).
