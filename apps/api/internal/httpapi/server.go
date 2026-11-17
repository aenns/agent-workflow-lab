package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/agent"
	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/checkpoint"
	"agent-workflow-lab/apps/api/internal/httpapi/contract"
	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// An interface describes the methods the HTTP layer needs. Tests can
// supply a fake service without starting Ollama or a Temporal worker.
type ChatService interface {
	Ready(context.Context) error
	Reply(context.Context, chat.Request) (chat.Reply, error)
}

var runIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

type Diagnostics struct {
	Jobs       JobService
	ListTools  func(context.Context) ([]*mcp.Tool, error)
	RecentLogs func() ([]json.RawMessage, error)
}

type server struct {
	service     ChatService
	name        string
	timeout     time.Duration
	diagnostics Diagnostics
}

// The generated router ties these handlers to operation IDs in openapi.yaml.
func Handler(service ChatService, name string, timeout time.Duration, diagnostics Diagnostics) http.Handler {
	handler := contract.HandlerWithOptions(server{service: service, name: name, timeout: timeout, diagnostics: diagnostics}, contract.StdHTTPServerOptions{
		ErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, _ error) {
			fail(w, http.StatusBadRequest, "Invalid request parameters.")
		},
	})
	return telemetry.HTTP(handler)
}

func (s server) GetOpenAPI(w http.ResponseWriter, _ *http.Request, _ contract.GetOpenAPIParams) {
	w.Header().Set("Content-Type", "application/yaml")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, contract.Document())
}

func (s server) GetHealth(w http.ResponseWriter, _ *http.Request, _ contract.GetHealthParams) {
	writeJSON(w, http.StatusOK, contract.Health{Status: "ok"})
}

func (s server) GetReadiness(w http.ResponseWriter, r *http.Request, _ contract.GetReadinessParams) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.service.Ready(ctx); err != nil {
		telemetry.Logger(ctx, "http").Warn("readiness.failed", "error_type", fmt.Sprintf("%T", err))
		detail := "Start Ollama and check that the configured model is installed."
		if errors.Is(err, agent.ErrMCP) {
			detail = "The MCP inventory server is unavailable. Restart the Go API."
		}
		writeJSON(w, http.StatusServiceUnavailable, contract.UnavailableReadiness{Status: "unavailable", Model: s.name, Error: detail})
		return
	}
	writeJSON(w, http.StatusOK, contract.Readiness{Status: "ready", Model: s.name})
}

func (s server) PostChat(w http.ResponseWriter, r *http.Request, _ contract.PostChatParams) {
	var body contract.PostChatJSONRequestBody
	// Decode a single JSON value and cap the request before allocating history.
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10))
	if err := decoder.Decode(&body); err != nil {
		invalidBody(w, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		invalidBody(w, err)
		return
	}
	input := toChatRequest(body)
	if !validMessages(input.Messages) {
		fail(w, http.StatusBadRequest, "Send 1–41 alternating user and assistant messages ending with a user message. User messages must contain 1–8,000 bytes of text.")
		return
	}
	// Clients from earlier phases omit the engine and keep the Go loop.
	if input.Engine == "" {
		input.Engine = chat.EngineLoop
	}
	if !contract.Engine(input.Engine).Valid() {
		fail(w, http.StatusBadRequest, "Choose the loop, state-machine, or temporal engine.")
		return
	}
	if input.Engine == chat.EngineStateMachine || input.Engine == chat.EngineTemporal {
		if input.RunID == "" {
			input.RunID = rand.Text()
		}
		if !runIDPattern.MatchString(input.RunID) {
			fail(w, http.StatusBadRequest, "Run ID must contain 16–64 letters, digits, underscores or hyphens.")
			return
		}
		// Keep the ID on error responses too, so API clients can retry the same run.
		w.Header().Set("X-Run-ID", input.RunID)
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.timeout)
	defer cancel()
	logger := telemetry.Logger(ctx, "chat").With("engine", input.Engine)
	if input.RunID != "" {
		logger = logger.With("run_id", input.RunID)
	}
	logger.Info("chat.started", "message_count", len(input.Messages))
	reply, err := s.service.Reply(ctx, input)
	if err != nil {
		logger.Warn("chat.failed", "error_type", fmt.Sprintf("%T", err))
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			if input.Engine == chat.EngineTemporal {
				fail(w, http.StatusGatewayTimeout, "The wait timed out. Resume the saved run to check its result.")
				return
			}
			fail(w, http.StatusGatewayTimeout, "The model took too long to reply. Try again.")
			return
		}
		switch {
		case errors.Is(err, checkpoint.ErrBusy), errors.Is(err, agent.ErrRunInput):
			fail(w, http.StatusConflict, err.Error())
		case errors.Is(err, agent.ErrCheckpoint):
			fail(w, http.StatusServiceUnavailable, "The checkpoint database is unavailable. Run make dev-db and retry.")
		case errors.Is(err, agent.ErrTemporal):
			fail(w, http.StatusServiceUnavailable, "Temporal is unavailable. Start its server and worker, then resume the saved run.")
		case errors.Is(err, agent.ErrTemporalRun):
			fail(w, http.StatusBadGateway, "The Temporal run failed. Check its workflow history or start a new chat.")
		case errors.Is(err, agent.ErrMCP):
			fail(w, http.StatusServiceUnavailable, "The MCP inventory server is unavailable. Restart the Go API.")
		case errors.Is(err, agent.ErrToolLimit):
			fail(w, http.StatusBadGateway, "The model requested too many tool calls. Try a smaller request.")
		default:
			fail(w, http.StatusBadGateway, "Ollama could not generate a reply. Check the model and try again.")
		}
		return
	}
	logger.Info("chat.completed", "tool_count", len(reply.Tools))
	writeJSON(w, http.StatusOK, toAPIReply(reply))
}

func validMessages(messages []chat.Message) bool {
	if len(messages) == 0 || len(messages) > 41 || len(messages)%2 == 0 {
		return false
	}
	for i, message := range messages {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		if message.Role != role || strings.TrimSpace(message.Content) == "" || (role == "user" && len(message.Content) > 8000) {
			return false
		}
	}
	return true
}

func invalidBody(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(w, http.StatusRequestEntityTooLarge, "The conversation exceeds 512 KiB. Start a new chat.")
		return
	}
	fail(w, http.StatusBadRequest, "Expected one JSON object containing messages.")
}

func fail(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, contract.Error{Error: message})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
