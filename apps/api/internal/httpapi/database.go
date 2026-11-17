package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"agent-workflow-lab/apps/api/internal/checkpoint"
	"agent-workflow-lab/apps/api/internal/httpapi/contract"
	"agent-workflow-lab/apps/api/internal/telemetry"
)

func (s server) ListDatabaseQueries(w http.ResponseWriter, _ *http.Request, _ contract.ListDatabaseQueriesParams) {
	queries := checkpoint.InspectionQueries()
	result := make([]contract.SavedQuery, 0, len(queries))
	for _, query := range queries {
		result = append(result, contract.SavedQuery{
			Id: query.ID, Title: query.Title, Description: query.Description,
			Sql: query.SQL, RequiresRunId: query.RequiresRunID,
		})
	}
	writeJSON(w, http.StatusOK, result)
}

func (s server) RunDatabaseQuery(w http.ResponseWriter, r *http.Request, _ contract.RunDatabaseQueryParams) {
	var input contract.DatabaseQueryRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "Choose a saved database query and provide its parameters.")
		return
	}
	var selected checkpoint.SavedQuery
	for _, query := range checkpoint.InspectionQueries() {
		if query.ID == input.QueryId {
			selected = query
			break
		}
	}
	if selected.ID == "" {
		fail(w, http.StatusBadRequest, "Unknown saved database query.")
		return
	}
	var id string
	if input.RunId != nil {
		id = strings.TrimSpace(*input.RunId)
	}
	if selected.RequiresRunID && !runIDPattern.MatchString(id) {
		fail(w, http.StatusBadRequest, "Enter a valid state-machine Run ID.")
		return
	}
	if s.diagnostics.InspectDatabase == nil {
		fail(w, http.StatusServiceUnavailable, "Database inspection is unavailable.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	logger := telemetry.Logger(ctx, "postgres").With("query", selected.ID)
	result, err := s.diagnostics.InspectDatabase(ctx, selected, id)
	if errors.Is(err, checkpoint.ErrNoCheckpoints) {
		fail(w, http.StatusConflict, "Run a State machine turn first to create the checkpoint table.")
		return
	}
	if err != nil {
		logger.Warn("database.query.failed")
		fail(w, http.StatusServiceUnavailable, "Could not run the query. Check PostgreSQL and try again.")
		return
	}
	logger.Info("database.query.completed", "row_count", len(result.Rows))
	writeJSON(w, http.StatusOK, contract.DatabaseQueryResult{Columns: result.Columns, Rows: result.Rows})
}
