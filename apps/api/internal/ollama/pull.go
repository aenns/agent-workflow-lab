package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"agent-workflow-lab/apps/api/internal/telemetry"
)

type PullProgress struct {
	Status    string `json:"status,omitempty"`
	Total     int64  `json:"total,omitempty"`
	Completed int64  `json:"completed,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (c Client) Pull(ctx context.Context, model string, report func(PullProgress) error) error {
	payload, err := json.Marshal(map[string]any{"model": model, "stream": true})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/pull", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if id := telemetry.Correlation(ctx); id != "" {
		req.Header.Set(telemetry.Header, id)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	stream := bufio.NewScanner(res.Body)
	for stream.Scan() {
		var progress PullProgress
		if err := json.Unmarshal(stream.Bytes(), &progress); err != nil {
			return fmt.Errorf("invalid download progress from Ollama")
		}
		if progress.Error != "" {
			return errors.New(progress.Error)
		}
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("Ollama returned HTTP %d", res.StatusCode)
		}
		if err := report(progress); err != nil {
			return err
		}
		if progress.Status == "success" {
			return nil
		}
	}
	if err := stream.Err(); err != nil {
		return err
	}
	return fmt.Errorf("Ollama ended the download before reporting success")
}
