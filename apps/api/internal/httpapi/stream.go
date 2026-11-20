package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"agent-workflow-lab/apps/api/internal/chat"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

func (s server) streamChat(w http.ResponseWriter, r *http.Request, input chat.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	w.WriteHeader(200)
	if err := controller.Flush(); err != nil {
		return
	}
	emit := func(event chat.StreamEvent) error {
		// Bound a stalled browser write without limiting model computation time.
		_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
		defer controller.SetWriteDeadline(time.Time{})
		if err := json.NewEncoder(w).Encode(event); err != nil {
			return err
		}
		return controller.Flush()
	}
	ctx := chat.WithEmitter(r.Context(), emit)
	reply, err := s.service.Reply(ctx, input)
	if err != nil {
		telemetry.Logger(ctx, "chat").Warn("chat.failed", "engine", input.Engine, "error_type", fmt.Sprintf("%T", err))
		message := "The streaming request failed. Try again or resume the saved run."
		if ctx.Err() != nil {
			message = "The chat request timed out or disconnected."
		}
		_ = emit(chat.StreamEvent{Type: "error", Error: message})
		return
	}
	telemetry.Logger(ctx, "chat").Info("chat.completed", "engine", input.Engine, "model", reply.Model, "tool_count", len(reply.Tools), "stream", true)
	_ = emit(chat.StreamEvent{Type: "complete", Reply: toAPIReply(reply)})
}
