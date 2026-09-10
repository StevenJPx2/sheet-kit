// sheet-kit renders a resolved manifest + data artifact into Google Sheets.
// Domain-agnostic: it knows tabs, typed columns, name-based formulas, freeze,
// gradients and line charts — nothing about GA4, Raven, or experiments.
//
// Usage:
//
//	sheet-kit validate --manifest manifest.json [--data data.json]
//	sheet-kit publish  --manifest manifest.json --data data.json   (not yet implemented)
//	sheet-kit version
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/AdeptMind/sheet-kit/internal/manifest"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr *os.File) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: sheet-kit <validate|publish|version> [flags]")
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Fprintf(stdout, "sheet-kit contract v%d\n", manifest.ContractVersion)
		return 0
	case "validate":
		return cmdValidate(args[1:], stdout, stderr)
	case "publish":
		return cmdPublish(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		return 2
	}
}

func cmdValidate(args []string, stdout, stderr *os.File) int {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	manifestPath := fs.String("manifest", "", "path to manifest.json")
	dataPath := fs.String("data", "", "optional path to data.json (checks tab.data_key coverage)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *manifestPath == "" {
		fmt.Fprintln(stderr, "--manifest is required")
		return 2
	}

	m, err := parseManifestFile(*manifestPath)
	if err != nil {
		fmt.Fprintf(stderr, "manifest: %v\n", err)
		return 1
	}

	if *dataPath != "" {
		data, err := parseDataFile(*dataPath)
		if err != nil {
			fmt.Fprintf(stderr, "data: %v\n", err)
			return 1
		}
		if err := checkCoverage(m, data); err != nil {
			fmt.Fprintf(stderr, "coverage: %v\n", err)
			return 1
		}
	}

	fmt.Fprintf(stdout, "ok: %d tab(s), contract v%d\n", len(m.Tabs), m.ContractVersion)
	return 0
}

func cmdPublish(args []string, stdout, stderr *os.File) int {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	fs.SetOutput(stderr)
	manifestPath := fs.String("manifest", "", "path to manifest.json")
	dataPath := fs.String("data", "", "path to data.json")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *manifestPath == "" || *dataPath == "" {
		fmt.Fprintln(stderr, "--manifest and --data are required")
		return 2
	}
	m, err := parseManifestFile(*manifestPath)
	if err != nil {
		fmt.Fprintf(stderr, "manifest: %v\n", err)
		return 1
	}
	data, err := parseDataFile(*dataPath)
	if err != nil {
		fmt.Fprintf(stderr, "data: %v\n", err)
		return 1
	}
	if err := checkCoverage(m, data); err != nil {
		fmt.Fprintf(stderr, "coverage: %v\n", err)
		return 1
	}
	// ponytail: publish path (A1 formula resolution, atomic Drive write, webhook
	// import + staleness handshake) lands with the apps-script move. Skeleton
	// validates the artifact end-to-end so `data` can wire against it today.
	fmt.Fprintf(stderr, "publish not yet implemented (validated %d tabs against data)\n", len(m.Tabs))
	return 3
}

// Data is the canonical rows artifact (contract/data.schema.json).
type Data struct {
	ContractVersion int                        `json:"contract_version"`
	Datasets        map[string][]map[string]any `json:"datasets"`
}

func parseManifestFile(path string) (*manifest.Manifest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return manifest.Parse(f)
}

func parseDataFile(path string) (*Data, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var d Data
	if err := json.NewDecoder(f).Decode(&d); err != nil {
		return nil, err
	}
	if d.ContractVersion != manifest.ContractVersion {
		return nil, fmt.Errorf("contract_version %d unsupported (this build speaks %d)", d.ContractVersion, manifest.ContractVersion)
	}
	return &d, nil
}

// checkCoverage confirms every manifest tab has a matching dataset.
func checkCoverage(m *manifest.Manifest, d *Data) error {
	for _, tab := range m.Tabs {
		if _, ok := d.Datasets[tab.DataKey]; !ok {
			return fmt.Errorf("tab %q wants dataset %q, absent from data.json", tab.Name, tab.DataKey)
		}
	}
	return nil
}
