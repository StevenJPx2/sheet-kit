package manifest

import (
	"strings"
	"testing"
)

const validManifest = `{
  "contract_version": 1,
  "spreadsheet_id": "sheet-abc",
  "tabs": [{
    "name": "Daily",
    "data_key": "daily",
    "columns": [
      {"name": "Date", "type": "date", "source_field": "date"},
      {"name": "Sessions", "type": "integer", "source_field": "sessions"},
      {"name": "Revenue", "type": "money", "source_field": "revenue"},
      {"name": "RPV", "type": "money", "formula": "={Revenue}/{Sessions}"}
    ],
    "gradients": [{"column": "RPV", "kind": "percentile"}],
    "charts": [{"type": "line", "x": "Date", "series": ["RPV"]}]
  }]
}`

func TestParseValid(t *testing.T) {
	if _, err := Parse(strings.NewReader(validManifest)); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"unknown formula ref": strings.Replace(validManifest, "{Revenue}/{Sessions}", "{Revenue}/{Missing}", 1),
		"both value sources": strings.Replace(validManifest,
			`{"name": "Date", "type": "date", "source_field": "date"}`,
			`{"name": "Date", "type": "date", "source_field": "date", "formula": "=1"}`, 1),
		"bad contract version": strings.Replace(validManifest, `"contract_version": 1`, `"contract_version": 2`, 1),
		"unknown chart series":  strings.Replace(validManifest, `"series": ["RPV"]`, `"series": ["Nope"]`, 1),
	}
	for name, doc := range cases {
		if _, err := Parse(strings.NewReader(doc)); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}
