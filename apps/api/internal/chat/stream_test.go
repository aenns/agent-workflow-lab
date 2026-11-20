package chat

import (
	"encoding/json"
	"testing"
)

func TestEmptySnapshotClearsPriorAttempt(t *testing.T) {
	data, err := json.Marshal(StreamEvent{Type: "model-snapshot", ActivityID: "model-3", Attempt: 2})
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	text, present := event["text"]
	if !present || text != "" || event["attempt"] != float64(2) {
		t.Fatalf("retry did not explicitly clear draft: %s", data)
	}
}
