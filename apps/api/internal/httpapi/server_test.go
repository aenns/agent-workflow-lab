package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"agent-workflow-lab/apps/api/internal/agent"
	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/httpapi"
	"agent-workflow-lab/apps/api/internal/mcptools"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/smallnest/langgraphgo/graph"
)

func toolSession(t *testing.T) *mcp.ClientSession {
	t.Helper()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	ctx := t.Context()
	server, err := mcptools.Server().Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func TestChatAndHealth(t *testing.T) {
	const id = "test-correlation-1234"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			w.Write([]byte(`{"models":[{"name":"qwen3:14b"}]}`))
		case "/api/chat":
			if got := r.Header.Get(telemetry.Header); got != id {
				t.Errorf("Ollama correlation ID = %q, want %q", got, id)
			}
			var input struct {
				Model    string
				Messages []ollama.Message
				Stream   *bool
				Think    *bool
				Tools    []ollama.Tool
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if r.Method != "POST" || input.Model != "qwen3:14b" || input.Stream == nil || *input.Stream ||
				input.Think == nil || *input.Think || len(input.Tools) != 2 || len(input.Messages) != 4 || input.Messages[3].Content != "What is it?" {
				t.Errorf("unexpected upstream request: %+v", input)
			}
			w.Write([]byte(`{"message":{"role":"assistant","content":"Maple."}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	model := ollama.Client{BaseURL: upstream.URL, Model: "qwen3:14b", HTTP: upstream.Client()}
	session := toolSession(t)
	handler := httpapi.Handler(agent.Agent{Model: model, Tools: session}, model.Model, time.Second, httpapi.Diagnostics{})
	for _, tc := range []struct {
		name, method, path, body string
		code                     int
		want                     string
	}{
		{"health", "GET", "/api/health", "", 200, "ok"},
		{"ready", "GET", "/api/ready", "", 200, "qwen3:14b"},
		{"chat history", "POST", "/api/chat", `{"messages":[{"role":"user","content":"Remember Maple."},{"role":"assistant","content":"Okay."},{"role":"user","content":"What is it?"}]}`, 200, "Maple."},
		{"invalid engine", "POST", "/api/chat", `{"messages":[{"role":"user","content":"Hello"}],"engine":"unknown"}`, 400, "Choose the loop"},
		{"invalid role", "POST", "/api/chat", `{"messages":[{"role":"assistant","content":"Hello"}]}`, 400, "alternating"},
		{"trailing JSON", "POST", "/api/chat", `{"messages":[]} {}`, 400, "one JSON"},
		{"oversize", "POST", "/api/chat", `{"messages":["` + strings.Repeat("a", 512<<10), 413, "512 KiB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			request.Header.Set(telemetry.Header, id)
			handler.ServeHTTP(response, request)
			if got := response.Header().Get(telemetry.Header); got != id {
				t.Fatalf("response correlation ID = %q, want %q", got, id)
			}
			if response.Code != tc.code || !strings.Contains(response.Body.String(), tc.want) {
				t.Fatalf("got %d %s", response.Code, response.Body.String())
			}
		})
	}

	model.Model = "missing"
	handler = httpapi.Handler(agent.Agent{Model: model, Tools: session}, model.Model, time.Second, httpapi.Diagnostics{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/ready", nil))
	if response.Code != 503 {
		t.Fatalf("missing model: got %d", response.Code)
	}
}

type failingModel struct {
	timeout bool
}

func (m failingModel) Ready(context.Context) error { return nil }
func (m failingModel) Reply(ctx context.Context, _ chat.Request) (chat.Reply, error) {
	if m.timeout {
		<-ctx.Done()
		return chat.Reply{}, ctx.Err()
	}
	return chat.Reply{}, context.Canceled
}

func TestChatFailures(t *testing.T) {
	for _, tc := range []struct {
		timeout bool
		code    int
	}{{false, 502}, {true, 504}} {
		handler := httpapi.Handler(failingModel{timeout: tc.timeout}, "test", 10*time.Millisecond, httpapi.Diagnostics{})
		response := httptest.NewRecorder()
		body := strings.NewReader(`{"messages":[{"role":"user","content":"Hi"}]}`)
		handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/chat", body))
		if response.Code != tc.code {
			t.Fatalf("want %d, got %d", tc.code, response.Code)
		}
	}
}

type testCheckpointStore struct {
	graph.CheckpointStore
	failVersion int
}

func (s *testCheckpointStore) Open(context.Context, string) (graph.CheckpointStore, func(), error) {
	return s, func() {}, nil
}

func (s *testCheckpointStore) Save(ctx context.Context, cp *graph.Checkpoint) error {
	if cp.Version == s.failVersion {
		return errors.New("test checkpoint write failure")
	}
	return s.CheckpointStore.Save(ctx, cp)
}

func TestChatRunsDependentMCPTools(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []ollama.Message
			Tools    []ollama.Tool
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if len(input.Tools) != 2 || len(input.Messages) == 0 {
			t.Error("expected discovered tools and conversation")
			w.WriteHeader(400)
			return
		}
		for _, message := range input.Messages {
			if message.Usage != nil {
				t.Error("usage metadata must not be sent back to Ollama")
			}
		}
		last := input.Messages[len(input.Messages)-1]
		switch {
		case last.Role == "user":
			w.Write([]byte(`{"prompt_eval_count":101,"eval_count":12,"message":{"role":"assistant","tool_calls":[{"function":{"name":"lookup_inventory","arguments":{"sku":"LAMP-42"}}}]}}`))
		case last.Role == "tool" && last.ToolName == "lookup_inventory" && strings.Contains(last.Content, `"warehouse":"north"`):
			w.Write([]byte(`{"prompt_eval_count":130,"eval_count":15,"message":{"role":"assistant","tool_calls":[{"function":{"name":"warehouse_hours","arguments":{"warehouse":"north"}}}]}}`))
		case last.Role == "tool" && last.ToolName == "warehouse_hours" && strings.Contains(last.Content, "09:00"):
			w.Write([]byte(`{"prompt_eval_count":171,"eval_count":20,"message":{"role":"assistant","content":"Seven lamps, with pickup from 09:00 to 16:00."}}`))
		default:
			t.Errorf("unexpected tool transcript: %+v", last)
			w.WriteHeader(400)
		}
	}))
	defer upstream.Close()
	model := ollama.Client{BaseURL: upstream.URL, Model: "qwen3:14b", HTTP: upstream.Client()}
	store := &testCheckpointStore{CheckpointStore: graph.NewMemoryCheckpointStore()}
	handler := httpapi.Handler(agent.Agent{Model: model, Tools: toolSession(t), Checkpoints: store}, model.Model, time.Second, httpapi.Diagnostics{})
	for _, tc := range []struct {
		engine chat.Engine
		states []string
	}{
		{chat.EngineLoop, nil},
		{chat.EngineStateMachine, []string{"asking_model", "running_tools", "asking_model", "running_tools", "asking_model", "completed"}},
	} {
		t.Run(string(tc.engine), func(t *testing.T) {
			response := httptest.NewRecorder()
			body := `{"engine":"` + string(tc.engine) + `","runId":"test-checkpoint-1234","messages":[{"role":"user","content":"Is LAMP-42 in stock, and when can I pick it up?"}]}`
			handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/chat", strings.NewReader(body)))
			var reply chat.Reply
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &reply) != nil {
				t.Fatalf("unexpected response: %d %s", response.Code, response.Body)
			}
			if reply.Engine != tc.engine || !slices.Equal(reply.States, tc.states) {
				t.Fatalf("unexpected engine or states: %+v", reply)
			}
			if len(reply.Tools) != 2 || reply.Tools[0].Name != "lookup_inventory" || reply.Tools[1].Name != "warehouse_hours" ||
				reply.Tools[0].IsError || reply.Tools[1].IsError || !strings.Contains(reply.Message.Content, "Seven lamps") {
				t.Fatalf("unexpected reply: %+v", reply)
			}
			if len(reply.Usage) != 3 {
				t.Fatalf("expected three model calls with token usage, got %+v", reply.Usage)
			}
			for i, expected := range [][2]int64{{101, 12}, {130, 15}, {171, 20}} {
				call := reply.Usage[i]
				if call.InputTokens == nil || call.OutputTokens == nil || *call.InputTokens != expected[0] || *call.OutputTokens != expected[1] {
					t.Fatalf("call %d had unexpected token usage: %+v", i+1, call)
				}
			}

			if tc.engine == chat.EngineStateMachine {
				checkpoints, err := store.ListByThread(t.Context(), reply.RunID)
				if err != nil || len(checkpoints) != 5 || reply.RunID != "test-checkpoint-1234" {
					t.Fatalf("expected five checkpoints, got %d: %v", len(checkpoints), err)
				}
				// Keep the first tool result, then fail the write that would
				// authorize the next tool. Retrying should resume from there.
				for _, cp := range checkpoints[2:] {
					if err := store.Delete(t.Context(), cp.ID); err != nil {
						t.Fatal(err)
					}
				}
				store.failVersion = 3
				failed := httptest.NewRecorder()
				handler.ServeHTTP(failed, httptest.NewRequest("POST", "/api/chat", strings.NewReader(body)))
				if failed.Code != 503 {
					t.Fatalf("expected storage error, got %d %s", failed.Code, failed.Body)
				}
				checkpoints, err = store.ListByThread(t.Context(), reply.RunID)
				if err != nil || len(checkpoints) != 2 {
					t.Fatalf("run advanced after write failure: %d checkpoints, %v", len(checkpoints), err)
				}
				store.failVersion = 0
				resumed := httptest.NewRecorder()
				handler.ServeHTTP(resumed, httptest.NewRequest("POST", "/api/chat", strings.NewReader(body)))
				var resumedReply chat.Reply
				if resumed.Code != 200 || json.Unmarshal(resumed.Body.Bytes(), &resumedReply) != nil ||
					resumedReply.Message != reply.Message || len(resumedReply.Tools) != 2 || len(resumedReply.Usage) != 3 ||
					!slices.Equal(resumedReply.States, reply.States) {
					t.Fatalf("unexpected resumed reply: %d %s", resumed.Code, resumed.Body)
				}
				checkpoints, err = store.ListByThread(t.Context(), reply.RunID)
				if err != nil || len(checkpoints) != 5 {
					t.Fatalf("resume did not continue from saved step: %d checkpoints, %v", len(checkpoints), err)
				}
			}
		})
	}
}
