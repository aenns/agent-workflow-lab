package chat

import (
	"context"
	"encoding/json"
)

// StreamEvent is ephemeral presentation data. Only a complete Reply is added to
// chat history; graph checkpoints continue to store whole model and tool steps.
type StreamEvent struct {
	ActivityID string `json:"activityId,omitempty"`
	Attempt    int32  `json:"attempt,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	Status     string `json:"message,omitempty"`
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	Name       string `json:"name,omitempty"`
	Reply      any    `json:"reply,omitempty"`
	Error      string `json:"error,omitempty"`
}
type Emitter func(StreamEvent) error
type emitterKey struct{}

// The callback belongs to one HTTP request and never enters serialized state.
func WithEmitter(ctx context.Context, emit Emitter) context.Context {
	return context.WithValue(ctx, emitterKey{}, emit)
}
func Streaming(ctx context.Context) bool { _, ok := ctx.Value(emitterKey{}).(Emitter); return ok }
func Emit(ctx context.Context, event StreamEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if emit, ok := ctx.Value(emitterKey{}).(Emitter); ok {
		return emit(event)
	}
	return nil
}

// A snapshot must explicitly clear a preceding draft when its text is empty.
func (e StreamEvent) MarshalJSON() ([]byte, error) {
	type plain StreamEvent
	if e.Type == "model-snapshot" {
		return json.Marshal(struct {
			plain
			Text string `json:"text"`
		}{plain(e), e.Text})
	}
	return json.Marshal(plain(e))
}
