package telemetry

import (
	"context"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Use a namespaced MCP metadata key. Tool schemas and arguments stay the same.
const mcpKey = "workflow-lab.dev/correlation-id"

func MCPMeta(ctx context.Context) mcp.Meta {
	if id := Correlation(ctx); id != "" {
		return mcp.Meta{mcpKey: id}
	}
	return nil
}

// MCPServer restores request context across the stdio process boundary.
func MCPServer(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != "tools/list" && method != "tools/call" {
			return next(ctx, method, req)
		}
		var meta mcp.Meta
		var tool string
		switch params := req.GetParams().(type) {
		case *mcp.ListToolsParams:
			if params != nil {
				meta = params.Meta
			}
		case *mcp.CallToolParamsRaw:
			if params != nil {
				meta, tool = params.Meta, params.Name
			}
		}
		id, _ := meta[mcpKey].(string)
		ctx = WithCorrelation(ctx, id)
		start := time.Now()
		result, err := next(ctx, method, req)
		reply, _ := result.(*mcp.CallToolResult)
		attrs := []any{"method", method, "duration_ms", time.Since(start).Milliseconds()}
		if tool != "" {
			attrs = append(attrs, "tool", tool)
		}
		logger := Logger(ctx, "mcp")
		if err != nil || (reply != nil && reply.IsError) {
			logger.Warn("mcp.request.failed", attrs...)
		} else {
			logger.Info("mcp.request.completed", attrs...)
		}
		return result, err
	}
}
