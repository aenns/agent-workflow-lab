package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"agent-workflow-lab/apps/api/internal/httpapi/contract"
)

func (s server) models(ctx context.Context) ([]string, error) {
	if s.diagnostics.ListModels == nil {
		return nil, errors.New("model catalog unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	installed, err := s.diagnostics.ListModels(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(installed))
	for _, model := range installed {
		if model.Name != "" && model.SupportsTools() {
			names = append(names, model.Name)
		}
	}
	slices.Sort(names)
	return slices.Compact(names), nil
}

func (s server) GetModels(w http.ResponseWriter, r *http.Request, _ contract.GetModelsParams) {
	models, err := s.models(r.Context())
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Could not list installed Ollama models.")
		return
	}
	writeJSON(w, http.StatusOK, contract.ModelCatalog{DefaultModel: s.name, Models: models})
}

func (s server) checkModel(w http.ResponseWriter, r *http.Request, model string) bool {
	if model == "" {
		return true
	}
	models, err := s.models(r.Context())
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "Could not check the requested Ollama model.")
		return false
	}
	if !slices.Contains(models, model) {
		fail(w, http.StatusBadRequest, "Choose an installed Ollama model that supports tools.")
		return false
	}
	return true
}
