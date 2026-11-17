package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/httpapi/contract"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

func (s server) SearchModels(w http.ResponseWriter, r *http.Request, params contract.SearchModelsParams) {
	query := strings.TrimSpace(params.Q)
	if query == "" || len(query) > 80 {
		fail(w, http.StatusBadRequest, "Enter a search query of up to 80 bytes.")
		return
	}
	if s.diagnostics.SearchLibrary == nil {
		fail(w, http.StatusServiceUnavailable, "Ollama Library search is unavailable.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	models, err := s.diagnostics.SearchLibrary(ctx, query)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Could not search the Ollama Library. You can still install a model by tag.")
		return
	}
	result := make([]contract.LibraryModel, 0, len(models))
	for _, model := range models {
		result = append(result, contract.LibraryModel{Tag: model.Tag, Url: model.URL})
	}
	writeJSON(w, http.StatusOK, result)
}

func (s server) InstallModel(w http.ResponseWriter, r *http.Request, _ contract.InstallModelParams) {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "Send the model tag as application/json.")
		return
	}
	var input contract.InstallModelRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "Expected one JSON object containing a model tag.")
		return
	}
	model := strings.TrimSpace(input.Model)
	if !ollama.ValidLibraryTag(model) {
		fail(w, http.StatusBadRequest, "Enter a local Ollama Library tag such as qwen3.5:9b.")
		return
	}
	if s.diagnostics.PullModel == nil {
		fail(w, http.StatusServiceUnavailable, "Local model installation is unavailable.")
		return
	}
	if !s.download.TryLock() {
		fail(w, http.StatusConflict, "A model download is already in progress.")
		return
	}
	defer s.download.Unlock()

	check, cancelCheck := context.WithTimeout(r.Context(), 8*time.Second)
	err := ollama.CheckLocalManifest(check, model)
	cancelCheck()
	if errors.Is(err, ollama.ErrNoLocalManifest) {
		fail(w, http.StatusBadRequest, "That tag has no downloadable local model. Check the model’s tags in the Ollama Library.")
		return
	}
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Could not verify the model tag with the Ollama registry. Try again.")
		return
	}

	// Model downloads can take longer than the chat write deadline. Stream
	// the progress and let client cancellation stop the upstream request.
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Time{})
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Hour)
	defer cancel()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	encoder := json.NewEncoder(w)
	report := func(progress ollama.PullProgress) error {
		if err := encoder.Encode(progress); err != nil {
			return err
		}
		return controller.Flush()
	}
	logger := telemetry.Logger(ctx, "ollama-client").With("model", model)
	logger.Info("ollama.pull.started")
	if err := s.diagnostics.PullModel(ctx, model, report); err != nil {
		logger.Warn("ollama.pull.ended", "canceled", r.Context().Err() != nil)
		if r.Context().Err() == nil {
			_ = report(ollama.PullProgress{Error: err.Error()})
		}
		return
	}
	logger.Info("ollama.pull.completed")
}
