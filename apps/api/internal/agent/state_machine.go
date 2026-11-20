package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/checkpoint"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/smallnest/langgraphgo/graph"
)

const (
	askingModel  = "asking_model"
	runningTools = "running_tools"
	completed    = "completed"
)

var ErrCheckpoint = errors.New("checkpoint database unavailable")
var ErrRunInput = errors.New("run ID already belongs to a different request")

// The graph's state is serializable. The model and MCP clients belong to
// the node functions, so connections are recreated normally after restart.
type graphState struct {
	Next     string
	Input    [32]byte
	Messages []ollama.Message
	Tools    []ollama.Tool
	Rounds   int
	Reply    chat.Reply
	Pending  []ollama.ToolCall
}

func (a Agent) runStateMachine(ctx context.Context, request chat.Request) (chat.Reply, error) {
	if a.Checkpoints == nil {
		return chat.Reply{}, ErrCheckpoint
	}
	input, err := json.Marshal(request.Messages)
	if err != nil {
		return chat.Reply{}, err
	}
	// Bind a run ID to the original conversation, so retrying with different
	// messages cannot continue from someone else’s checkpoint.
	hash := sha256.Sum256(input)
	store, closeRun, err := a.Checkpoints.Open(ctx, request.RunID)
	if errors.Is(err, checkpoint.ErrBusy) {
		return chat.Reply{}, err
	}
	if err != nil {
		return chat.Reply{}, fmt.Errorf("%w: %w", ErrCheckpoint, err)
	}
	defer closeRun()

	state, err := a.loadGraphState(ctx, store, request, hash)
	if err != nil {
		return chat.Reply{}, err
	}
	if state.Next == completed {
		return state.Reply, nil
	}

	// LangGraphGo schedules the nodes and saves their output after each
	// successful step. A tool node handles one call, even in a batch.
	guard := &checkedStore{CheckpointStore: store}
	builder := graph.NewCheckpointableStateGraphWithConfig[graphState](graph.CheckpointConfig{Store: guard, AutoSave: true})
	builder.AddNode(askingModel, "Ask Ollama for an answer or tool requests", guard.node(a.modelNode))
	builder.AddNode(runningTools, "Execute the next MCP call", guard.node(a.toolNode))
	builder.SetEntryPoint(askingModel)
	route := func(_ context.Context, state graphState) string {
		if state.Next == completed {
			return graph.END
		}
		return state.Next
	}
	builder.AddConditionalEdge(askingModel, route)
	builder.AddConditionalEdge(runningTools, route)
	workflow, err := builder.CompileCheckpointable()
	if err != nil {
		return chat.Reply{}, err
	}

	// The library's automatic resume uses the saved node name. Its
	// checkpoints label the node just executed, so use the saved next node.
	workflow.SetExecutionID(request.RunID)
	cfg := graph.WithThreadID(request.RunID)
	cfg.ResumeFrom = []string{state.Next}
	result, err := workflow.InvokeWithConfig(ctx, state, cfg)
	if guard.err != nil {
		return chat.Reply{}, guard.err
	}
	return result.Reply, err
}

func (a Agent) loadGraphState(ctx context.Context, store graph.CheckpointStore, request chat.Request, hash [32]byte) (graphState, error) {
	checkpoints, err := store.ListByThread(ctx, request.RunID)
	if err != nil {
		return graphState{}, fmt.Errorf("%w: %w", ErrCheckpoint, err)
	}
	var latest *graph.Checkpoint
	for _, cp := range checkpoints {
		if latest == nil || cp.Version > latest.Version {
			latest = cp
		}
	}
	if latest != nil {
		// The PostgreSQL saver decodes generic state as JSON data. Restore
		// our typed state before passing it back to the graph runtime.
		raw, err := json.Marshal(latest.State)
		var state graphState
		if err == nil {
			err = json.Unmarshal(raw, &state)
		}
		if err != nil {
			return graphState{}, fmt.Errorf("%w: %w", ErrCheckpoint, err)
		}
		if state.Input != hash || (request.Model != "" && state.Reply.Model != "" && state.Reply.Model != request.Model) {
			return graphState{}, ErrRunInput
		}
		return state, nil
	}
	t, err := a.withModel(request.Model).newTurn(ctx, request.Messages, request.Engine)
	if err != nil {
		return graphState{}, err
	}
	t.reply.RunID = request.RunID
	t.reply.States = []string{askingModel}
	return graphState{Next: askingModel, Input: hash, Messages: t.messages, Tools: t.tools, Reply: t.reply}, nil
}

func (a Agent) modelNode(ctx context.Context, state graphState) (graphState, error) {
	t := turn{agent: a.withModel(state.Reply.Model), messages: state.Messages, tools: state.Tools, rounds: state.Rounds, reply: state.Reply}
	message, err := t.askModel(ctx)
	if err != nil {
		return state, err
	}
	state.Reply = t.reply
	if len(message.ToolCalls) == 0 {
		state.Reply = t.finish(message)
		state.move(completed)
	} else {
		state.Messages = append(state.Messages, message)
		state.Pending = message.ToolCalls
		state.move(runningTools)
	}
	return state, nil
}

func (a Agent) toolNode(ctx context.Context, state graphState) (graphState, error) {
	if len(state.Pending) == 0 {
		return state, fmt.Errorf("%w: no pending tool at tool node", ErrCheckpoint)
	}
	t := turn{agent: a, messages: state.Messages, allowed: toolNames(state.Tools), reply: state.Reply}
	if err := t.recordTool(ctx, state.Pending[0]); err != nil {
		return state, err
	}
	if err := ctx.Err(); err != nil {
		return state, err
	}
	state.Messages, state.Reply = t.messages, t.reply
	state.Pending = state.Pending[1:]
	if len(state.Pending) == 0 {
		state.Rounds++
		state.move(askingModel)
	}
	return state, nil
}

func (s *graphState) move(next string) {
	s.Next = next
	s.Reply.States = append(s.Reply.States, next)
}

// v0.8.5's automatic checkpoint hook drops save errors. Capture the
// failure and check it before another node can perform I/O or return success.
type checkedStore struct {
	graph.CheckpointStore
	err error
}

func (s *checkedStore) List(ctx context.Context, id string) ([]*graph.Checkpoint, error) {
	result, err := s.CheckpointStore.List(ctx, id)
	if err != nil {
		s.err = fmt.Errorf("%w: %w", ErrCheckpoint, err)
	}
	return result, err
}

func (s *checkedStore) Save(ctx context.Context, cp *graph.Checkpoint) error {
	if s.err != nil {
		return s.err
	}
	logger := telemetry.Logger(ctx, "postgres").With("node", cp.NodeName, "version", cp.Version)
	if err := s.CheckpointStore.Save(ctx, cp); err != nil {
		s.err = fmt.Errorf("%w: %w", ErrCheckpoint, err)
		logger.Warn("checkpoint.write.failed")
	} else {
		logger.Info("checkpoint.written")
	}
	return s.err
}

func (s *checkedStore) node(run func(context.Context, graphState) (graphState, error)) func(context.Context, graphState) (graphState, error) {
	return func(ctx context.Context, state graphState) (graphState, error) {
		if s.err != nil {
			return state, s.err
		}
		if err := ctx.Err(); err != nil {
			return state, err
		}
		return run(ctx, state)
	}
}
