---
name: sheet-kit
description: Render Google Sheets from a manifest + data with the `sheet-kit` CLI — validate, compile and deploy the Apps Script renderer, publish data, and inspect live sheets. Use when writing a sheet-kit manifest (columns, formulas, gradients, headings), wiring the webhook/Apps Script, or when a published sheet renders stale or wrong structure.
allowed-tools: Bash(sheet-kit:*)
hidden: true
---

# sheet-kit — generic Google Sheets renderer

This is a discovery stub, not the guide. Before writing a manifest or running
`sheet-kit`, load the version-matched content from the CLI:

```bash
sheet-kit skills get core          # model, workflows, the gotchas that bite
sheet-kit skills get core --full   # + the command + manifest reference
```

The CLI serves its own skill content, so the guidance always matches the
installed `sheet-kit`. `sheet-kit skills list` shows what's available.
