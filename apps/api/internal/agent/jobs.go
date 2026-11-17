package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/telemetry"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/converter"
)

const auditWorkflow = "InventoryAudit"
const JobPrefix = "lab-job-"

var ErrJobNotFound = errors.New("inventory job not found")

type Job struct {
	ID            string
	CorrelationID string
	Prompt        string
	Status        string
	StartedAt     time.Time
	FinishedAt    *time.Time
	Reply         *chat.Reply
}

// StartJob waits for Temporal to accept the workflow, then returns without
// waiting for any model or MCP activity to run.
func (e TemporalEngine) StartJob(ctx context.Context, key, prompt string) (Job, error) {
	id := JobPrefix + key
	_, err := e.start(ctx, id, auditWorkflow, []chat.Message{{Role: "user", Content: prompt}}, prompt)
	if err != nil {
		return Job{}, err
	}
	return Job{ID: id, Prompt: prompt, Status: "running", StartedAt: time.Now(), CorrelationID: telemetry.Correlation(ctx)}, nil
}

func (e TemporalEngine) ListJobs(ctx context.Context) ([]Job, error) {
	result, err := e.Client.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{
		Query:    "WorkflowType = '" + auditWorkflow + "'",
		PageSize: 50,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrTemporal, err)
	}
	jobs := make([]Job, 0, len(result.Executions))
	for _, execution := range result.Executions {
		jobs = append(jobs, jobSummary(execution))
	}
	return jobs, nil
}

func (e TemporalEngine) GetJob(ctx context.Context, id string) (Job, error) {
	if !strings.HasPrefix(id, JobPrefix) {
		return Job{}, ErrJobNotFound
	}
	result, err := e.Client.DescribeWorkflowExecution(ctx, id, "")
	var missing *serviceerror.NotFound
	if errors.As(err, &missing) {
		return Job{}, ErrJobNotFound
	}
	if err != nil {
		return Job{}, fmt.Errorf("%w: %w", ErrTemporal, err)
	}
	info := result.GetWorkflowExecutionInfo()
	if info.GetType().GetName() != auditWorkflow {
		return Job{}, ErrJobNotFound
	}
	job := jobSummary(info)
	if info.GetStatus() == enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED {
		var reply chat.Reply
		run := e.Client.GetWorkflow(ctx, id, info.GetExecution().GetRunId())
		if err := run.Get(ctx, &reply); err != nil {
			return Job{}, fmt.Errorf("%w: %w", ErrTemporal, err)
		}
		job.Reply = &reply
	}
	return job, nil
}

func jobSummary(info *workflowpb.WorkflowExecutionInfo) Job {
	job := Job{
		ID:        info.GetExecution().GetWorkflowId(),
		StartedAt: info.GetStartTime().AsTime(),
		Status:    "failed",
	}
	switch info.GetStatus() {
	case enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING:
		job.Status = "running"
	case enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:
		job.Status = "completed"
	}
	if info.GetCloseTime() != nil {
		finished := info.GetCloseTime().AsTime()
		job.FinishedAt = &finished
	}
	if payload := info.GetMemo().GetFields()["prompt"]; payload != nil {
		_ = converter.GetDefaultDataConverter().FromPayload(payload, &job.Prompt)
	}
	if payload := info.GetMemo().GetFields()["correlationId"]; payload != nil {
		_ = converter.GetDefaultDataConverter().FromPayload(payload, &job.CorrelationID)
	}
	return job
}
