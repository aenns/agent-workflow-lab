package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

type Client struct {
	BaseURL string
	Model   string
	HTTP    *http.Client
}

func (c Client) request(ctx context.Context, method, path string, body io.Reader, result any) (err error) {
	start := time.Now()
	status := 0
	defer func() {
		logger := telemetry.Logger(ctx, "ollama-client")
		attrs := []any{"method", method, "route", path, "status", status, "duration_ms", time.Since(start).Milliseconds()}
		if path == "/api/chat" {
			attrs = append(attrs, "model", c.Model)
		}
		if err != nil {
			logger.Warn("ollama.request.failed", attrs...)
		} else {
			logger.Info("ollama.request.completed", attrs...)
		}
	}()
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if id := telemetry.Correlation(ctx); id != "" {
		req.Header.Set(telemetry.Header, id)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	status = res.StatusCode
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Ollama %s returned HTTP %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(result)
}

type InstalledModel struct {
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
}

func (m InstalledModel) SupportsTools() bool {
	// Some Ollama versions omit capabilities from the model list.
	return len(m.Capabilities) == 0 || slices.Contains(m.Capabilities, "tools")
}

func (c Client) ListModels(ctx context.Context) ([]InstalledModel, error) {
	var result struct {
		Models []InstalledModel `json:"models"`
	}
	err := c.request(ctx, http.MethodGet, "/api/tags", nil, &result)
	return result.Models, err
}

func (c Client) Ready(ctx context.Context) error {
	models, err := c.ListModels(ctx)
	if err != nil {
		return err
	}

	model := c.Model
	if !strings.Contains(model[strings.LastIndex(model, "/")+1:], ":") {
		model += ":latest"
	}
	for _, entry := range models {
		if entry.Name == model {
			return nil
		}
	}
	return fmt.Errorf("model %q is not installed", c.Model)
}

type Function struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

type Tool struct {
	Type     string   `json:"type"`
	Function Function `json:"function"`
}

type ToolCall struct {
	Type     string `json:"type,omitempty"`
	Function struct {
		Index     int             `json:"index"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	// Usage travels with the Temporal activity result and is stripped
	// before the assistant message is added to the Ollama transcript.
	Usage     *chat.TokenUsage `json:"usage,omitempty"`
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls []ToolCall       `json:"tool_calls,omitempty"`
	ToolName  string           `json:"tool_name,omitempty"`
}

// Ollama returns either a final text message or a structured list of tool
// calls. This client decodes those responses. The engine decides what runs.
func (c Client) Complete(ctx context.Context, messages []Message, tools []Tool) (Message, error) {
	if chat.Streaming(ctx) {
		return c.completeStream(ctx, messages, tools)
	}
	payload, err := json.Marshal(struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Tools    []Tool    `json:"tools,omitempty"`
		Stream   bool      `json:"stream"`
		Think    bool      `json:"think"`
	}{Model: c.Model, Messages: messages, Tools: tools})
	if err != nil {
		return Message{}, err
	}
	var result struct {
		Message         Message `json:"message"`
		PromptEvalCount *int64  `json:"prompt_eval_count"`
		EvalCount       *int64  `json:"eval_count"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/chat", bytes.NewReader(payload), &result); err != nil {
		return Message{}, err
	}
	if result.Message.Role != "assistant" || (len(result.Message.ToolCalls) == 0 && strings.TrimSpace(result.Message.Content) == "") {
		return Message{}, fmt.Errorf("Ollama returned an empty or invalid assistant reply")
	}
	result.Message.Usage = &chat.TokenUsage{InputTokens: result.PromptEvalCount, OutputTokens: result.EvalCount}
	return result.Message, nil
}
