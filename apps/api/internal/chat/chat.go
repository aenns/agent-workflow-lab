package chat

import "encoding/json"

// Engine selects the orchestration for one chat turn.
type Engine string

const (
	EngineLoop         Engine = "loop"
	EngineStateMachine Engine = "state-machine"
	EngineTemporal     Engine = "temporal"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Request struct {
	Model    string    `json:"model,omitempty"`
	Messages []Message `json:"messages"`
	Engine   Engine    `json:"engine"`
	RunID    string    `json:"runId,omitempty"`
}

// TokenUsage contains the counts Ollama reported for one model call.
type TokenUsage struct {
	InputTokens  *int64 `json:"inputTokens,omitempty"`
	OutputTokens *int64 `json:"outputTokens,omitempty"`
}

type Reply struct {
	Model   string       `json:"model,omitempty"`
	Usage   []TokenUsage `json:"usage,omitempty"`
	RunID   string       `json:"runId,omitempty"`
	Engine  Engine       `json:"engine"`
	States  []string     `json:"states,omitempty"`
	Message Message      `json:"message"`
	Tools   []ToolEvent  `json:"tools,omitempty"`
}

type ToolEvent struct {
	Name       string          `json:"name"`
	Arguments  json.RawMessage `json:"arguments"`
	Result     string          `json:"result"`
	IsError    bool            `json:"isError"`
	DurationMS int64           `json:"durationMs"`
}
