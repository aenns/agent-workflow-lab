package httpapi_test

import (
	"context"
	"encoding/json"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agent-workflow-lab/apps/api/internal/agent"
	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/httpapi"
	"agent-workflow-lab/apps/api/internal/httpapi/contract"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type specService struct {
	readyErr error
	chatErr  error
}

func (s specService) Ready(context.Context) error { return s.readyErr }

func (s specService) Reply(_ context.Context, request chat.Request) (chat.Reply, error) {
	reply := chat.Reply{
		RunID: request.RunID, Engine: request.Engine,
		Message: chat.Message{Role: "assistant", Content: "Seven lamps."},
	}
	if request.Engine == chat.EngineStateMachine {
		reply.States = []string{"asking_model", "running_tools", "asking_model", "completed"}
		reply.Tools = []chat.ToolEvent{{Name: "lookup_inventory", Arguments: json.RawMessage(`{"sku":"LAMP-42"}`), Result: "Seven lamps."}}
	}
	if request.Engine == chat.EngineTemporal {
		reply.RunID = "lab-chat-" + request.RunID
		// A rejected tool call can have absent or malformed arguments.
		reply.Tools = []chat.ToolEvent{{Name: "lookup_inventory", Result: "Invalid arguments", IsError: true}}
	}
	return reply, s.chatErr
}

type specJobs struct{}

const specJobID = "lab-job-demo-request-1234"

func (specJobs) StartJob(_ context.Context, key, prompt string) (agent.Job, error) {
	return agent.Job{ID: agent.JobPrefix + key, Prompt: prompt, Status: "running", StartedAt: time.Now()}, nil
}
func (specJobs) ListJobs(context.Context) ([]agent.Job, error) {
	return []agent.Job{{ID: specJobID, Prompt: "Check stock.", Status: "completed", StartedAt: time.Now()}}, nil
}
func (specJobs) GetJob(_ context.Context, id string) (agent.Job, error) {
	jobs, _ := (specJobs{}).ListJobs(context.Background())
	if id != specJobID {
		return agent.Job{}, agent.ErrJobNotFound
	}
	job := jobs[0]
	job.Reply = &chat.Reply{Engine: chat.EngineTemporal, Message: chat.Message{Role: "assistant", Content: "Seven lamps."}}
	return job, nil
}

func TestOpenAPIContract(t *testing.T) {
	spec, err := openapi3.NewLoader().LoadFromData([]byte(contract.Document()))
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(t.Context()); err != nil {
		t.Fatal(err)
	}
	diagnostics := httpapi.Diagnostics{
		Jobs: specJobs{},
		ListTools: func(context.Context) ([]*mcp.Tool, error) {
			return []*mcp.Tool{{Name: "lookup_inventory", Description: "Look up stock", InputSchema: map[string]any{"type": "object"}}}, nil
		},
		RecentLogs: func() ([]json.RawMessage, error) {
			return []json.RawMessage{json.RawMessage(`{"time":"2026-01-01T00:00:00Z","msg":"chat.completed","service":"api"}`)}, nil
		},
	}
	chatBody := `{"messages":[{"role":"user","content":"Check LAMP-42."}]`
	for _, tc := range []struct {
		name, method, path, body string
		service                  specService
		status                   int
		durable                  bool
		noDiagnostics            bool
	}{
		{name: "spec", method: "GET", path: "/api/openapi.yaml", status: 200},
		{name: "tools", method: "GET", path: "/api/tools", status: 200},
		{name: "tools unavailable", method: "GET", path: "/api/tools", status: 503, noDiagnostics: true},
		{name: "logs", method: "GET", path: "/api/logs", status: 200},
		{name: "logs unavailable", method: "GET", path: "/api/logs", status: 503, noDiagnostics: true},
		{name: "job accepted", method: "POST", path: "/api/jobs", body: `{"prompt":"Check stock.","key":"demo-request-1234"}`, status: 202},
		{name: "jobs listed", method: "GET", path: "/api/jobs", status: 200},
		{name: "job result", method: "GET", path: "/api/jobs/" + specJobID, status: 200},
		{name: "job missing", method: "GET", path: "/api/jobs/lab-job-missing-request-1234", status: 404},
		{name: "blank job", method: "POST", path: "/api/jobs", body: `{"prompt":" "}`, status: 400},
		{name: "health", method: "GET", path: "/api/health", status: 200},
		{name: "ready", method: "GET", path: "/api/ready", status: 200},
		{name: "unavailable", method: "GET", path: "/api/ready", service: specService{readyErr: agent.ErrMCP}, status: 503},
		{name: "loop", method: "POST", path: "/api/chat", body: chatBody + "}", status: 200},
		{name: "state machine", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"state-machine"}`, status: 200, durable: true},
		{name: "temporal", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"temporal"}`, status: 200, durable: true},
		{name: "invalid", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"unknown"}`, status: 400},
		{name: "conflict", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"temporal"}`, service: specService{chatErr: agent.ErrRunInput}, status: 409, durable: true},
		{name: "too large", method: "POST", path: "/api/chat", body: `{"messages":["` + strings.Repeat("a", 512<<10), status: 413},
		{name: "upstream failure", method: "POST", path: "/api/chat", body: chatBody + "}", service: specService{chatErr: agent.ErrToolLimit}, status: 502},
		{name: "checkpoint unavailable", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"state-machine"}`, service: specService{chatErr: agent.ErrCheckpoint}, status: 503, durable: true},
		{name: "timeout", method: "POST", path: "/api/chat", body: chatBody + `,"engine":"temporal"}`, service: specService{chatErr: context.DeadlineExceeded}, status: 504, durable: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sources := diagnostics
			if tc.noDiagnostics {
				sources = httpapi.Diagnostics{}
			}
			handler := httpapi.Handler(tc.service, "qwen3:14b", time.Second, sources)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
			if res.Code != tc.status {
				t.Fatalf("got HTTP %d, want %d: %s", res.Code, tc.status, res.Body)
			}
			path := tc.path
			if strings.HasPrefix(path, "/api/jobs/") {
				path = "/api/jobs/{jobId}"
			}
			if tc.status == 202 && res.Header().Get("Location") != "/api/jobs/"+specJobID {
				t.Fatalf("unexpected job location: %s", res.Header().Get("Location"))
			}
			definition := spec.Paths.Find(path)
			if definition == nil || definition.GetOperation(tc.method) == nil {
				t.Fatalf("%s %s is missing from the spec", tc.method, tc.path)
			}
			operation := definition.GetOperation(tc.method)
			if tc.method == http.MethodPost && res.Code < http.StatusBadRequest {
				var request any
				if err := json.Unmarshal([]byte(tc.body), &request); err != nil {
					t.Fatal(err)
				}
				bodySchema := operation.RequestBody.Value.Content["application/json"].Schema.Value
				if err := bodySchema.VisitJSON(request); err != nil {
					t.Fatalf("request does not match OpenAPI: %v", err)
				}
			}
			response := operation.Responses.Status(res.Code)
			if response == nil {
				t.Fatalf("HTTP %d is missing from the spec", res.Code)
			}
			assertHeader := func(name string) {
				t.Helper()
				header := response.Value.Headers[name]
				if header == nil {
					t.Fatalf("%s is missing from the spec", name)
				}
				if err := header.Value.Schema.Value.VisitJSON(res.Header().Get(name)); err != nil {
					t.Errorf("%s does not match OpenAPI: %v", name, err)
				}
			}
			assertHeader("X-Correlation-ID")
			if tc.durable {
				assertHeader("X-Run-ID")
			}
			contentType, _, err := mime.ParseMediaType(res.Header().Get("Content-Type"))
			if err != nil || response.Value.Content[contentType] == nil {
				t.Fatalf("unexpected content type %q: %v", contentType, err)
			}
			if tc.path == "/api/openapi.yaml" {
				if res.Body.String() != contract.Document() {
					t.Fatal("served spec differs from the embedded source")
				}
				return
			}
			var body any
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if err := response.Value.Content[contentType].Schema.Value.VisitJSON(body); err != nil {
				t.Fatalf("response does not match OpenAPI: %v", err)
			}
		})
	}
}
