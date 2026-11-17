package httpapi

import (
	"context"
	"net/http"
	"time"

	"agent-workflow-lab/apps/api/internal/httpapi/contract"
)

func (s server) GetTools(w http.ResponseWriter, r *http.Request, _ contract.GetToolsParams) {
	if s.diagnostics.ListTools == nil {
		fail(w, http.StatusServiceUnavailable, "MCP tool discovery is unavailable.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	discovered, err := s.diagnostics.ListTools(ctx)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "The MCP server could not list its tools.")
		return
	}
	tools := make([]contract.MCPTool, 0, len(discovered))
	for _, tool := range discovered {
		tools = append(tools, contract.MCPTool{
			Name: tool.Name, Description: tool.Description, InputSchema: tool.InputSchema,
		})
	}
	writeJSON(w, http.StatusOK, tools)
}

func (s server) GetLogs(w http.ResponseWriter, _ *http.Request, _ contract.GetLogsParams) {
	if s.diagnostics.RecentLogs == nil {
		fail(w, http.StatusServiceUnavailable, "Local logs are unavailable.")
		return
	}
	records, err := s.diagnostics.RecentLogs()
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "The local log files could not be read.")
		return
	}
	writeJSON(w, http.StatusOK, records)
}
