package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

// Assemble structured tool calls before returning them to the engine. Partial
// text is safe to display, but must never trigger a tool or checkpoint a draft.
func (c Client) completeStream(ctx context.Context, messages []Message, tools []Tool) (Message, error) {
	if err := chat.Emit(ctx, chat.StreamEvent{Type: "model-start"}); err != nil {
		return Message{}, err
	}
	payload, err := json.Marshal(map[string]any{"model": c.Model, "messages": messages, "tools": tools, "stream": true, "think": false})
	if err != nil {
		return Message{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(telemetry.Header, telemetry.Correlation(ctx))
	start := time.Now()
	res, err := c.HTTP.Do(req)
	if err != nil {
		return Message{}, err
	}
	defer res.Body.Close()
	defer func() {
		telemetry.Logger(ctx, "ollama-client").Info("ollama.request.completed", "route", "/api/chat", "status", res.StatusCode, "model", c.Model, "stream", true, "duration_ms", time.Since(start).Milliseconds())
	}()
	if res.StatusCode != 200 {
		return Message{}, fmt.Errorf("Ollama returned HTTP %d", res.StatusCode)
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	answer := Message{Role: "assistant"}
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var chunk struct {
			Message Message `json:"message"`
			Done    bool    `json:"done"`
			Error   string  `json:"error"`
			Input   *int64  `json:"prompt_eval_count"`
			Output  *int64  `json:"eval_count"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			return Message{}, err
		}
		if chunk.Error != "" {
			return Message{}, fmt.Errorf("Ollama stream failed")
		}
		answer.Content += chunk.Message.Content
		answer.ToolCalls = append(answer.ToolCalls, chunk.Message.ToolCalls...)
		if chunk.Message.Content != "" {
			if err := chat.Emit(ctx, chat.StreamEvent{Type: "text", Text: chunk.Message.Content}); err != nil {
				return Message{}, err
			}
		}
		if chunk.Done {
			if len(answer.ToolCalls) == 0 && strings.TrimSpace(answer.Content) == "" {
				return Message{}, fmt.Errorf("Ollama returned an empty reply")
			}
			answer.Usage = &chat.TokenUsage{InputTokens: chunk.Input, OutputTokens: chunk.Output}
			return answer, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return Message{}, err
	}
	return Message{}, fmt.Errorf("Ollama stream ended before completion")
}
