// Package manifest is the sheet-kit render contract (v1): Go structs mirroring
// contract/manifest.schema.json plus Validate. sheet-kit renders a Manifest
// against a Data artifact with no domain knowledge.
package manifest

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// ContractVersion is the manifest/data contract version this build speaks.
// Bump only on a breaking change; see contract/VERSION.
const ContractVersion = 1

type Manifest struct {
	ContractVersion int    `json:"contract_version"`
	SpreadsheetID   string `json:"spreadsheet_id"`
	Tabs            []Tab  `json:"tabs"`
}

type Tab struct {
	Name         string        `json:"name"`
	DataKey      string        `json:"data_key"`
	Columns      []Column      `json:"columns"`
	HeaderRow      int            `json:"header_row,omitempty"`
	Freeze         *Freeze        `json:"freeze,omitempty"`
	HeaderMerges   []Merge        `json:"header_merges,omitempty"`
	NumberFormats  []NumberFormat `json:"number_formats,omitempty"`
	RowLabelStyles []RowLabelStyle `json:"row_label_styles,omitempty"`
	TextRules      []TextRule     `json:"text_rules,omitempty"`
	ColumnWidths   []ColumnWidth  `json:"column_widths,omitempty"`
	Gradients      []Gradient     `json:"gradients,omitempty"`
	Charts         []Chart        `json:"charts,omitempty"`
}

type Column struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	SourceField string `json:"source_field,omitempty"`
	Formula     string `json:"formula,omitempty"`
}

type Freeze struct {
	Rows int `json:"rows,omitempty"`
	Cols int `json:"cols,omitempty"`
}

type Merge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}

type NumberFormat struct {
	Column string `json:"column"`
	Format string `json:"format"`
}

type RowLabelStyle struct {
	Match LabelMatch `json:"match"`
	Style RowStyle   `json:"style"`
}

type RowStyle struct {
	Bold      bool   `json:"bold,omitempty"`
	Background string `json:"background,omitempty"`
	FontColor string `json:"font_color,omitempty"`
	FontSize  int    `json:"font_size,omitempty"`
	Merge     bool   `json:"merge,omitempty"`
	RowHeight int    `json:"row_height,omitempty"`
}

type LabelMatch struct {
	Column string `json:"column,omitempty"`
	Prefix string `json:"prefix,omitempty"`
	Suffix string `json:"suffix,omitempty"`
	Equals string `json:"equals,omitempty"`
}

type TextRule struct {
	Equals string `json:"equals"`
	Color  string `json:"color"`
}

type ColumnWidth struct {
	Column string `json:"column"`
	Width  int    `json:"width"`
}

type Gradient struct {
	Column   string `json:"column"`
	Kind     string `json:"kind"`
	MinColor string `json:"min_color,omitempty"`
	MidColor string `json:"mid_color,omitempty"`
	MaxColor string `json:"max_color,omitempty"`
	MinValue any    `json:"min_value,omitempty"`
	MidValue any    `json:"mid_value,omitempty"`
	MaxValue any    `json:"max_value,omitempty"`
}

type Chart struct {
	Type        string   `json:"type"`
	Title       string   `json:"title,omitempty"`
	X           string   `json:"x"`
	Series      []string `json:"series"`
	NumHeaders  int      `json:"num_headers,omitempty"`
	VAxisFormat string   `json:"v_axis_format,omitempty"`
	Colors      []string `json:"colors,omitempty"`
	Width       int      `json:"width,omitempty"`
	Height      int      `json:"height,omitempty"`
	Position    *ChartPos `json:"position,omitempty"`
}

type ChartPos struct {
	Row int `json:"row,omitempty"`
	Col int `json:"col,omitempty"`
}

var (
	validColumnTypes  = map[string]bool{"string": true, "number": true, "integer": true, "money": true, "percent": true, "date": true, "hour": true}
	validGradientKind = map[string]bool{"number": true, "percent": true, "percentile": true, "min": true, "max": true}
)

// Parse decodes and validates a manifest from r.
func Parse(r io.Reader) (*Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate enforces the invariants the schema can express plus the cross-field
// rules a renderer relies on: contract version, one value source per column,
// and that every referenced column name actually exists on its tab.
func (m *Manifest) Validate() error {
	if m.ContractVersion != ContractVersion {
		return fmt.Errorf("contract_version %d unsupported (this build speaks %d)", m.ContractVersion, ContractVersion)
	}
	if m.SpreadsheetID == "" {
		return fmt.Errorf("spreadsheet_id is required")
	}
	if len(m.Tabs) == 0 {
		return fmt.Errorf("manifest has no tabs")
	}
	for ti := range m.Tabs {
		if err := m.Tabs[ti].validate(); err != nil {
			return fmt.Errorf("tab %q: %w", m.Tabs[ti].Name, err)
		}
	}
	return nil
}

func (t *Tab) validate() error {
	if t.Name == "" {
		return fmt.Errorf("name is required")
	}
	if t.DataKey == "" {
		return fmt.Errorf("data_key is required")
	}
	if len(t.Columns) == 0 {
		return fmt.Errorf("has no columns")
	}

	names := make(map[string]bool, len(t.Columns))
	for ci := range t.Columns {
		c := &t.Columns[ci]
		if c.Name == "" {
			return fmt.Errorf("column %d: name is required", ci)
		}
		if names[c.Name] {
			return fmt.Errorf("duplicate column name %q", c.Name)
		}
		names[c.Name] = true

		if !validColumnTypes[c.Type] {
			return fmt.Errorf("column %q: invalid type %q", c.Name, c.Type)
		}
		if (c.SourceField == "") == (c.Formula == "") {
			return fmt.Errorf("column %q: exactly one of source_field or formula is required", c.Name)
		}
	}

	// Every {Name} referenced in a formula, gradient, chart or section rule
	// must resolve to a real column on this tab.
	for ci := range t.Columns {
		for _, ref := range formulaRefs(t.Columns[ci].Formula) {
			if !names[ref] {
				return fmt.Errorf("column %q formula references unknown column %q", t.Columns[ci].Name, ref)
			}
		}
	}
	for _, g := range t.Gradients {
		if !names[g.Column] {
			return fmt.Errorf("gradient references unknown column %q", g.Column)
		}
		if !validGradientKind[g.Kind] {
			return fmt.Errorf("gradient on %q: invalid kind %q", g.Column, g.Kind)
		}
	}
	for _, nf := range t.NumberFormats {
		if !names[nf.Column] {
			return fmt.Errorf("number_format references unknown column %q", nf.Column)
		}
	}
	for _, cw := range t.ColumnWidths {
		if !names[cw.Column] {
			return fmt.Errorf("column_width references unknown column %q", cw.Column)
		}
	}
	for _, rls := range t.RowLabelStyles {
		if rls.Match.Column != "" && !names[rls.Match.Column] {
			return fmt.Errorf("row_label_style references unknown column %q", rls.Match.Column)
		}
	}
	for _, hm := range t.HeaderMerges {
		if !names[hm.From] || !names[hm.To] {
			return fmt.Errorf("header_merge references unknown column %q/%q", hm.From, hm.To)
		}
	}
	for _, ch := range t.Charts {
		if ch.Type != "line" {
			return fmt.Errorf("chart: unsupported type %q", ch.Type)
		}
		if !names[ch.X] {
			return fmt.Errorf("chart references unknown x column %q", ch.X)
		}
		if len(ch.Series) == 0 {
			return fmt.Errorf("chart %q: no series", ch.Title)
		}
		for _, s := range ch.Series {
			if !names[s] {
				return fmt.Errorf("chart references unknown series column %q", s)
			}
		}
	}
	return nil
}

// formulaRefs extracts {ColumnName} references from a name-based formula.
// ponytail: naive brace scan, not a full expression parser — upgrade to a real
// tokenizer only if formulas gain string literals containing braces.
func formulaRefs(formula string) []string {
	if formula == "" {
		return nil
	}
	var refs []string
	for {
		open := strings.IndexByte(formula, '{')
		if open < 0 {
			break
		}
		close := strings.IndexByte(formula[open:], '}')
		if close < 0 {
			break
		}
		refs = append(refs, formula[open+1:open+close])
		formula = formula[open+close+1:]
	}
	return refs
}
