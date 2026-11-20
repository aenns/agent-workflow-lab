package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

func TestStreamingCompletion(t *testing.T) {
	for _, terminal := range []string{"done", "truncated", "malformed", "model-error"} {
		t.Run(terminal, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["stream"] != true || body["model"] != "test-model" || r.Header.Get("X-Correlation-ID") != "stream-test-correlation" {
					t.Error("missing stream settings or correlation")
				}
				_, _ = w.Write([]byte("{\"message\":{\"role\":\"assistant\",\"content\":\"Café\"},\"done\":false}\n"))
				switch terminal {
				case "done":
					_, _ = w.Write([]byte("{\"message\":{\"role\":\"assistant\",\"content\":\"!\",\"tool_calls\":[{\"function\":{\"name\":\"lookup_inventory\",\"arguments\":{\"sku\":\"LAMP-42\"}}}]},\"done\":true,\"prompt_eval_count\":12,\"eval_count\":4}\n"))
				case "malformed":
					_, _ = w.Write([]byte("{broken\n"))
				case "model-error":
					_, _ = w.Write([]byte("{\"error\":\"model failed\"}\n"))
				}
			}))
			defer server.Close()
			var events []chat.StreamEvent
			ctx := chat.WithEmitter(telemetry.WithCorrelation(context.Background(), "stream-test-correlation"), func(event chat.StreamEvent) error { events = append(events, event); return nil })
			result, err := (Client{BaseURL: server.URL, Model: "test-model", HTTP: server.Client()}).Complete(ctx, nil, nil)
			if terminal != "done" {
				if err == nil {
					t.Fatal("incomplete or corrupt stream accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Content != "Café!" || len(result.ToolCalls) != 1 || *result.Usage.InputTokens != 12 || *result.Usage.OutputTokens != 4 {
				t.Fatalf("invalid assembled reply: %+v", result)
			}
			if len(events) != 3 || events[0].Type != "model-start" || events[1].Text != "Café" || events[2].Text != "!" {
				t.Fatalf("unexpected events: %+v", events)
			}
		})
	}
}

func TestStreamCallbackFailureStopsModelRequest(t *testing.T) {
	failure := errors.New("browser disconnected")
	ctx := chat.WithEmitter(context.Background(), func(chat.StreamEvent) error { return failure })
	_, err := (Client{}).Complete(ctx, nil, nil)
	if !errors.Is(err, failure) {
		t.Fatalf("callback failure was lost: %v", err)
	}
}
