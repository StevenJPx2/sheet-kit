// Package publish writes the artifact (manifest.json + data.json) to the mounted
// Google Drive folder and triggers the generic Apps Script webhook to render it.
// Domain-agnostic: it moves files and POSTs a token; all rendering happens in
// apps-script/. Ported from ga4-querinator's postDailyPerformanceWebhook, minus
// every HA-specific field.
package publish

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config is the webhook endpoint + shared secret (a small JSON file on the host).
type Config struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
	// DriveDir is the mounted Google Drive folder the webhook reads artifacts from.
	DriveDir string `json:"driveDir"`
}

type webhookResult struct {
	OK     bool   `json:"ok"`
	Stale  bool   `json:"stale"`
	Latest string `json:"latest"`
	Error  string `json:"error"`
}

// Publish copies manifest.json + data.json from artifactDir into the mounted
// Drive folder, then POSTs the webhook and runs the Drive-sync staleness retry
// loop until the importer confirms it rendered the just-written data.
func Publish(cfg Config, artifactDir, expectedLatest string, client *http.Client, log io.Writer) error {
	endpoint, err := url.Parse(cfg.URL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || strings.TrimSpace(cfg.Secret) == "" {
		return errors.New("invalid webhook config")
	}
	if cfg.DriveDir == "" {
		return errors.New("driveDir is required")
	}

	for _, name := range []string{"manifest.json", "data.json"} {
		if err := copyFile(filepath.Join(artifactDir, name), filepath.Join(cfg.DriveDir, name)); err != nil {
			return fmt.Errorf("stage %s to Drive: %w", name, err)
		}
	}

	body, err := json.Marshal(map[string]string{
		"token":          strings.TrimSpace(cfg.Secret),
		"manifest":       "manifest.json",
		"data":           "data.json",
		"expectedLatest": expectedLatest,
	})
	if err != nil {
		return err
	}

	// The mounted Drive file syncs to the cloud asynchronously, so the importer
	// may briefly read stale bytes. Retry until it reports the just-written data.
	deadline := time.Now().Add(5 * time.Minute)
	transientRetries := 0
	for {
		result, err := postOnce(client, cfg.URL, body)
		if err != nil {
			return err
		}
		if result.OK {
			return nil
		}
		if result.Stale {
			if time.Now().After(deadline) {
				return fmt.Errorf("sheet still stale after retries (latest=%s, want %s)", result.Latest, expectedLatest)
			}
			fmt.Fprintf(log, "artifact not synced yet (latest=%s, want %s); retrying in 15s\n", result.Latest, expectedLatest)
			time.Sleep(15 * time.Second)
			continue
		}
		if transientRetries < 3 {
			transientRetries++
			fmt.Fprintf(log, "import error (%s); retry %d/3 in 10s\n", result.Error, transientRetries)
			time.Sleep(10 * time.Second)
			continue
		}
		return fmt.Errorf("webhook rejected import after %d retries: %s", transientRetries, result.Error)
	}
}

func postOnce(client *http.Client, endpoint string, body []byte) (webhookResult, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return webhookResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return webhookResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return webhookResult{}, fmt.Errorf("webhook HTTP %d", resp.StatusCode)
	}
	var result webhookResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return webhookResult{}, fmt.Errorf("decode webhook response: %w", err)
	}
	return result, nil
}

func copyFile(src, dst string) error {
	in, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, in, 0o644)
}
