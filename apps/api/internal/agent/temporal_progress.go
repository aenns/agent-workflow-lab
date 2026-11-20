package agent

import (
	"context"
	"sync"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
)

type progressSnapshot struct {
	Version    int    `json:"version"`
	Type       string `json:"type"`
	Text       string `json:"text"`
	Name       string `json:"name"`
	ActivityID string `json:"activityId"`
	Attempt    int32  `json:"attempt"`
	Truncated  bool   `json:"truncated"`
}

// Heartbeats are latest-value previews. They never change the workflow's
// activity results or scheduling, and an interrupted model attempt starts over.
func activityProgress(ctx context.Context) (context.Context, func()) {
	info := activity.GetInfo(ctx)
	state := progressSnapshot{Version: 1, Type: "model", ActivityID: info.ActivityID, Attempt: info.Attempt}
	var mu sync.Mutex
	last := time.Time{}
	beat := func() {
		mu.Lock()
		defer mu.Unlock()
		last = time.Now()
		activity.RecordHeartbeat(ctx, state)
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				beat()
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	emit := func(event chat.StreamEvent) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		mu.Lock()
		switch event.Type {
		case "model-start":
			state.Type = "model"
			state.Text = ""
			state.Truncated = false
		case "text":
			text := []rune(state.Text + event.Text)
			if len(text) > 16000 {
				text = text[:16000]
				state.Truncated = true
			}
			state.Text = string(text)
			if time.Since(last) < 400*time.Millisecond {
				mu.Unlock()
				return nil
			}
		case "tool-start", "tool-complete":
			state.Type = event.Type
			state.Name = event.Name
			state.Text = ""
		default:
			mu.Unlock()
			return nil
		}
		copy := state
		last = time.Now()
		activity.RecordHeartbeat(ctx, copy)
		mu.Unlock()
		return nil
	}
	return chat.WithEmitter(ctx, emit), func() { close(done) }
}

func (e TemporalEngine) waitProgress(ctx context.Context, run client.WorkflowRun) (chat.Reply, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type outcome struct {
		reply chat.Reply
		err   error
	}
	finished := make(chan outcome, 1)
	go func() { var reply chat.Reply; err := run.Get(ctx, &reply); finished <- outcome{reply, err} }()
	if err := chat.Emit(ctx, chat.StreamEvent{Type: "status", Status: "Waiting for a Temporal worker…"}); err != nil {
		return chat.Reply{}, err
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var previous progressSnapshot
	for {
		select {
		case result := <-finished:
			return result.reply, result.err
		case <-ctx.Done():
			return chat.Reply{}, ctx.Err()
		case <-ticker.C:
			info, err := e.Client.DescribeWorkflowExecution(ctx, run.GetID(), run.GetRunID())
			if err != nil {
				return chat.Reply{}, err
			}
			for _, pending := range info.GetPendingActivities() {
				var snapshot progressSnapshot
				details := pending.GetHeartbeatDetails()
				if details == nil || converter.GetDefaultDataConverter().FromPayloads(details, &snapshot) != nil || snapshot.Version != 1 || snapshot == previous {
					continue
				}
				previous = snapshot
				event := chat.StreamEvent{Type: snapshot.Type, Name: snapshot.Name}
				if snapshot.Type == "model" {
					event = chat.StreamEvent{Type: "model-snapshot", Text: snapshot.Text, ActivityID: snapshot.ActivityID, Attempt: snapshot.Attempt, Truncated: snapshot.Truncated}
				}
				if err := chat.Emit(ctx, event); err != nil {
					return chat.Reply{}, err
				}
			}
		}
	}
}
