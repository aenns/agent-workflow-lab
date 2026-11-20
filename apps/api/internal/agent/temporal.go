package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const temporalQueue = "workflow-lab-chat"
const temporalWorkflow = "InventoryChat"
const discoverActivity = "DiscoverMCPTools"
const modelActivity = "AskOllama"
const toolActivity = "CallMCPTool"
const toolLimitType = "ToolLimit"

var ErrTemporal = errors.New("Temporal service unavailable")
var ErrTemporalRun = errors.New("Temporal workflow failed")

type TemporalEngine struct {
	Client       client.Client
	Timeout      time.Duration
	DefaultModel string
}

func (e TemporalEngine) Reply(ctx context.Context, request chat.Request) (chat.Reply, error) {
	run, err := e.start(ctx, "lab-chat-"+request.RunID, temporalWorkflow, request.Messages, "", request.Model)
	if err != nil {
		return chat.Reply{}, err
	}

	// Canceling the HTTP wait leaves the workflow running in Temporal.
	// Another request with the same ID can reattach and read the result.
	var reply chat.Reply
	var waitErr error
	if chat.Streaming(ctx) {
		reply, waitErr = e.waitProgress(ctx, run)
	} else {
		waitErr = run.Get(ctx, &reply)
	}
	if err := waitErr; err != nil {
		var application *temporal.ApplicationError
		if errors.As(err, &application) && application.Type() == toolLimitType {
			return chat.Reply{}, ErrToolLimit
		}
		var failed *temporal.WorkflowExecutionError
		if errors.As(err, &failed) {
			return chat.Reply{}, fmt.Errorf("%w: %w", ErrTemporalRun, err)
		}
		return chat.Reply{}, fmt.Errorf("%w: %w", ErrTemporal, err)
	}
	return reply, nil
}

// Both entry points use a stable workflow ID. Temporal rejects duplicate IDs
// and the saved fingerprint lets a retry reattach only to the original input.
func (e TemporalEngine) start(ctx context.Context, id, workflowName string, messages []chat.Message, prompt, model string) (client.WorkflowRun, error) {
	input, err := json.Marshal(messages)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(input)
	fingerprint := hex.EncodeToString(hash[:])
	chosen := model
	if chosen == "" {
		chosen = e.DefaultModel
	}
	run, err := e.Client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                                       id,
		TaskQueue:                                temporalQueue,
		WorkflowExecutionTimeout:                 max(15*time.Minute, 2*e.Timeout),
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
		Memo:                                     map[string]any{"inputHash": fingerprint, "prompt": prompt, "model": chosen, "correlationId": telemetry.Correlation(ctx)},
	}, workflowName, workflowInput{Messages: messages, ModelTimeout: e.Timeout, Model: chosen})
	logger := telemetry.Logger(ctx, "temporal-client").With("workflow_id", id)
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &alreadyStarted) {
		existing, describeErr := e.Client.DescribeWorkflowExecution(ctx, id, "")
		if describeErr != nil {
			return nil, fmt.Errorf("%w: %w", ErrTemporal, describeErr)
		}
		var existingHash string
		data := existing.GetWorkflowExecutionInfo().GetMemo().GetFields()["inputHash"]
		if data == nil || converter.GetDefaultDataConverter().FromPayload(data, &existingHash) != nil || existingHash != fingerprint {
			return nil, ErrRunInput
		}
		if saved := existing.GetWorkflowExecutionInfo().GetMemo().GetFields()["model"]; saved != nil && model != "" {
			var recorded string
			if converter.GetDefaultDataConverter().FromPayload(saved, &recorded) != nil || recorded != model {
				return nil, ErrRunInput
			}
		}
		logger.Info("workflow.reattached")
		run = e.Client.GetWorkflow(ctx, id, existing.GetWorkflowExecutionInfo().GetExecution().GetRunId())
	} else if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrTemporal, err)
	} else {
		logger.Info("workflow.submitted", "model", chosen)
	}

	return run, nil
}

type workflowInput struct {
	Model        string
	Messages     []chat.Message
	ModelTimeout time.Duration
}

type modelInput struct {
	Model    string
	Messages []ollama.Message
	Tools    []ollama.Tool
	Rounds   int
	Calls    int
}

type toolInput struct {
	Call    ollama.ToolCall
	Allowed bool
}

// Only the activities perform I/O. Temporal can replay this function using
// recorded activity results to reconstruct its transcript and tool budget.
func inventoryWorkflow(ctx workflow.Context, input workflowInput) (chat.Reply, error) {
	retry := &temporal.RetryPolicy{InitialInterval: time.Second, MaximumInterval: 5 * time.Second, MaximumAttempts: 3}
	quick := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 15 * time.Second, RetryPolicy: retry})
	model := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: input.ModelTimeout, HeartbeatTimeout: 10 * time.Second, RetryPolicy: retry,
	})
	logger := workflow.GetLogger(ctx)
	logger.Info("workflow.started", telemetry.CorrelationField, telemetry.WorkflowCorrelation(ctx), "model", input.Model)
	var tools []ollama.Tool
	if err := workflow.ExecuteActivity(quick, discoverActivity).Get(ctx, &tools); err != nil {
		return chat.Reply{}, err
	}
	t := turn{messages: modelMessages(input.Messages), tools: tools, allowed: toolNames(tools), reply: chat.Reply{
		Engine: chat.EngineTemporal, Model: input.Model, RunID: workflow.GetInfo(ctx).WorkflowExecution.ID,
	}}
	for {
		var message ollama.Message
		if err := workflow.ExecuteActivity(model, modelActivity, modelInput{
			Model: input.Model, Messages: t.messages, Tools: t.tools, Rounds: t.rounds, Calls: len(t.reply.Tools),
		}).Get(ctx, &message); err != nil {
			return chat.Reply{}, err
		}
		message = t.recordUsage(message)
		if len(message.ToolCalls) == 0 {
			logger.Info("workflow.completed", telemetry.CorrelationField, telemetry.WorkflowCorrelation(ctx), "tool_count", len(t.reply.Tools))
			return t.finish(message), nil
		}
		t.messages = append(t.messages, message)
		for index, call := range message.ToolCalls {
			var event chat.ToolEvent
			// Activity IDs also appear in the Temporal history, so tool
			// names are visible alongside the scheduled and completed events.
			name := "unknown"
			allowed := t.allowed[call.Function.Name]
			if allowed {
				name = call.Function.Name
			}
			toolCtx := workflow.WithActivityOptions(quick, workflow.ActivityOptions{
				ActivityID:          fmt.Sprintf("tool-%d-%d-%s", t.rounds+1, index+1, name),
				StartToCloseTimeout: 15 * time.Second, RetryPolicy: retry,
			})
			if err := workflow.ExecuteActivity(toolCtx, toolActivity, toolInput{
				Call: call, Allowed: allowed,
			}).Get(ctx, &event); err != nil {
				return chat.Reply{}, err
			}
			t.recordToolResult(event)
		}
		t.rounds++
	}
}

// A separate workflow type makes background audits discoverable without
// mixing them with synchronous chat turns.
func inventoryAuditWorkflow(ctx workflow.Context, input workflowInput) (chat.Reply, error) {
	return inventoryWorkflow(ctx, input)
}

func (a Agent) Worker(c client.Client) worker.Worker {
	w := worker.New(c, temporalQueue, worker.Options{Identity: os.Getenv("LAB_WORKER_IDENTITY"), WorkerStopTimeout: 2 * time.Second, MaxHeartbeatThrottleInterval: 500 * time.Millisecond, DefaultHeartbeatThrottleInterval: 500 * time.Millisecond})
	w.RegisterWorkflowWithOptions(inventoryWorkflow, workflow.RegisterOptions{Name: temporalWorkflow})
	w.RegisterWorkflowWithOptions(inventoryAuditWorkflow, workflow.RegisterOptions{Name: auditWorkflow})
	w.RegisterActivityWithOptions(a.discover, activity.RegisterOptions{Name: discoverActivity})
	w.RegisterActivityWithOptions(a.temporalAskModel, activity.RegisterOptions{Name: modelActivity})
	w.RegisterActivityWithOptions(a.temporalCallTool, activity.RegisterOptions{Name: toolActivity})
	return w
}

func (a Agent) temporalAskModel(ctx context.Context, input modelInput) (ollama.Message, error) {
	ctx, closeProgress := activityProgress(ctx)
	defer closeProgress()
	message, err := a.withModel(input.Model).askModel(ctx, input.Messages, input.Tools, input.Rounds, input.Calls)
	if errors.Is(err, ErrToolLimit) {
		return ollama.Message{}, temporal.NewNonRetryableApplicationError(err.Error(), toolLimitType, err)
	}
	return message, err
}

func (a Agent) temporalCallTool(ctx context.Context, input toolInput) (chat.ToolEvent, error) {
	ctx, closeProgress := activityProgress(ctx)
	defer closeProgress()
	if err := chat.Emit(ctx, chat.StreamEvent{Type: "tool-start", Name: input.Call.Function.Name}); err != nil {
		return chat.ToolEvent{}, err
	}
	event := a.call(ctx, input.Call, input.Allowed)
	return event, chat.Emit(ctx, chat.StreamEvent{Type: "tool-complete", Name: input.Call.Function.Name})
}
