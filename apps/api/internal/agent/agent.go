package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/checkpoint"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxToolRounds = 4
const maxToolCalls = 8

var ErrMCP = errors.New("MCP inventory server unavailable")
var ErrToolLimit = errors.New("model exceeded the tool call limit")

// Agent holds connections shared across requests. A turn holds the mutable
// transcript, so two chats can run without sharing conversation state.
type Agent struct {
	Model       ollama.Client
	Tools       *mcp.ClientSession
	Checkpoints checkpoint.Store
	Temporal    *TemporalEngine
}

func (a Agent) Ready(ctx context.Context) error {
	if err := a.Model.Ready(ctx); err != nil {
		return err
	}
	_, err := a.discover(ctx)
	return err
}

// ListTools reads the live MCP registry. The UI and model both use it so a
// change to the server definitions appears in discovery and in model prompts.
func (a Agent) ListTools(ctx context.Context) ([]*mcp.Tool, error) {
	tools := make([]*mcp.Tool, 0)
	for tool, err := range a.Tools.Tools(ctx, &mcp.ListToolsParams{Meta: telemetry.MCPMeta(ctx)}) {
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrMCP, err)
		}
		tools = append(tools, tool)
	}
	telemetry.Logger(ctx, "mcp-client").Info("mcp.tools.discovered", "tool_count", len(tools))
	return tools, nil
}

func (a Agent) discover(ctx context.Context) ([]ollama.Tool, error) {
	discovered, err := a.ListTools(ctx)
	if err != nil {
		return nil, err
	}
	if len(discovered) == 0 {
		return nil, fmt.Errorf("%w: no tools discovered", ErrMCP)
	}
	tools := make([]ollama.Tool, 0, len(discovered))
	for _, tool := range discovered {
		tools = append(tools, ollama.Tool{
			Type: "function",
			Function: ollama.Function{
				Name: tool.Name, Description: tool.Description, Parameters: tool.InputSchema,
			},
		})
	}
	return tools, nil
}

// Reply routes a chat request to the selected engine.
func (a Agent) Reply(ctx context.Context, request chat.Request) (chat.Reply, error) {
	switch request.Engine {
	case chat.EngineLoop:
		turn, err := a.newTurn(ctx, request.Messages, request.Engine)
		if err != nil {
			return chat.Reply{}, err
		}
		return turn.runLoop(ctx)
	case chat.EngineStateMachine:
		return a.runStateMachine(ctx, request)
	case chat.EngineTemporal:
		if a.Temporal == nil {
			return chat.Reply{}, ErrTemporal
		}
		return a.Temporal.Reply(ctx, request)
	default:
		return chat.Reply{}, fmt.Errorf("unsupported engine %q", request.Engine)
	}
}

// A turn accumulates the model transcript and the tool trace returned to
// React. The transcript includes intermediate messages that the UI omits.
type turn struct {
	agent    Agent
	messages []ollama.Message
	tools    []ollama.Tool
	allowed  map[string]bool
	rounds   int
	reply    chat.Reply
}

func (a Agent) newTurn(ctx context.Context, history []chat.Message, engine chat.Engine) (*turn, error) {
	tools, err := a.discover(ctx)
	if err != nil {
		return nil, err
	}

	return &turn{agent: a, messages: modelMessages(history), tools: tools, allowed: toolNames(tools), reply: chat.Reply{Engine: engine}}, nil

}

// Put the system instructions first and translate each browser message to
// the model wire format. The transcript is assembled again for each turn.
func modelMessages(history []chat.Message) []ollama.Message {
	messages := make([]ollama.Message, 0, len(history)+1)
	messages = append(messages, ollama.Message{Role: "system", Content: "Use the provided tools for facts about demo inventory and warehouse pickup hours. If a required SKU or warehouse ID is missing, ask for it unless it can be obtained from the conversation or a tool result. Do not invent inventory facts. Answer other questions normally."})
	for _, message := range history {
		messages = append(messages, ollama.Message{Role: message.Role, Content: message.Content})
	}
	return messages
}

func toolNames(tools []ollama.Tool) map[string]bool {
	allowed := make(map[string]bool, len(tools))
	for _, tool := range tools {
		allowed[tool.Function.Name] = true
	}
	return allowed
}

// The simplest engine controls execution with an ordinary Go loop. A model
// response either ends the turn or supplies another batch of tool calls.
func (t *turn) runLoop(ctx context.Context) (chat.Reply, error) {
	for {
		message, err := t.askModel(ctx)
		if err != nil {
			return chat.Reply{}, err
		}
		if len(message.ToolCalls) == 0 {
			return t.finish(message), nil
		}
		if err := t.runTools(ctx, message); err != nil {
			return chat.Reply{}, err
		}
	}
}

// Once the tool budget is spent, give the model one request to finish
// using the results it already has. Reject any additional tool calls.
func (t *turn) askModel(ctx context.Context) (ollama.Message, error) {
	message, err := t.agent.askModel(ctx, t.messages, t.tools, t.rounds, len(t.reply.Tools))
	if err != nil {
		return ollama.Message{}, err
	}
	return t.recordUsage(message), nil
}

// Preserve each call’s counts in order. The model transcript only needs
// the assistant message itself when it is sent back to Ollama.
func (t *turn) recordUsage(message ollama.Message) ollama.Message {
	if message.Usage != nil {
		t.reply.Usage = append(t.reply.Usage, *message.Usage)
	}
	message.Usage = nil
	return message
}

func (a Agent) askModel(ctx context.Context, messages []ollama.Message, tools []ollama.Tool, rounds, calls int) (ollama.Message, error) {
	final := rounds >= maxToolRounds || calls >= maxToolCalls
	available := tools
	if final {
		available = nil
	}
	message, err := a.Model.Complete(ctx, messages, available)
	if err != nil {
		return ollama.Message{}, err
	}
	if len(message.ToolCalls) > 0 && (final || calls+len(message.ToolCalls) > maxToolCalls) {
		return ollama.Message{}, ErrToolLimit
	}
	return message, nil
}

func (t *turn) runTools(ctx context.Context, message ollama.Message) error {
	// Ollama needs both its original tool request and the matching tool
	// responses in the transcript to continue generating the answer.
	t.messages = append(t.messages, message)
	for _, call := range message.ToolCalls {
		if err := ctx.Err(); err != nil {
			return err
		}
		t.recordTool(ctx, call)
	}
	t.rounds++
	return nil
}

func (t *turn) recordTool(ctx context.Context, call ollama.ToolCall) {
	t.recordToolResult(t.agent.call(ctx, call, t.allowed[call.Function.Name]))
}

func (t *turn) recordToolResult(event chat.ToolEvent) {
	t.reply.Tools = append(t.reply.Tools, event)
	t.messages = append(t.messages, ollama.Message{
		Role: "tool", ToolName: event.Name, Content: event.Result,
	})
}

func (t *turn) finish(message ollama.Message) chat.Reply {
	t.reply.Message = chat.Message{Role: message.Role, Content: message.Content}
	return t.reply
}

func (a Agent) call(ctx context.Context, call ollama.ToolCall, allowed bool) chat.ToolEvent {
	event := chat.ToolEvent{Name: call.Function.Name, Arguments: call.Function.Arguments, IsError: true}
	// A model response is input, so check its tool name and arguments before
	// making an MCP request. The server validates the tool-specific schema.
	switch {
	case !allowed:
		event.Result = "Unknown tool. Use a tool from the provided list."
	case len(event.Arguments) == 0 || event.Arguments[0] != '{':
		event.Result = "Tool arguments must be a JSON object."
	default:
		start := time.Now()
		logger := telemetry.Logger(ctx, "mcp-client").With("tool", event.Name)
		result, err := a.Tools.CallTool(ctx, &mcp.CallToolParams{
			Meta: telemetry.MCPMeta(ctx), Name: event.Name, Arguments: event.Arguments,
		})
		event.DurationMS = time.Since(start).Milliseconds()
		if err != nil {
			logger.Warn("mcp.call.failed", "duration_ms", event.DurationMS, "error_type", fmt.Sprintf("%T", err))
			event.Result = "MCP tool call failed. Check the arguments against the tool schema."
			return event
		}
		var lines []string
		for _, content := range result.Content {
			if value, ok := content.(*mcp.TextContent); ok {
				lines = append(lines, value.Text)
			}
		}
		event.Result = strings.Join(lines, "\n")
		event.IsError = result.IsError
		logger.Info("mcp.call.completed", "duration_ms", event.DurationMS, "tool_error", event.IsError)
	}
	return event
}
