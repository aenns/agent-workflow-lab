package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"agent-workflow-lab/apps/api/internal/agent"
	"agent-workflow-lab/apps/api/internal/checkpoint"
	"agent-workflow-lab/apps/api/internal/config"
	"agent-workflow-lab/apps/api/internal/httpapi"
	"agent-workflow-lab/apps/api/internal/lablogs"
	"agent-workflow-lab/apps/api/internal/mcptools"
	"agent-workflow-lab/apps/api/internal/ollama"
	"agent-workflow-lab/apps/api/internal/telemetry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	temporalclient "go.temporal.io/sdk/client"
	temporallog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/workflow"
)

func main() {
	serviceName := "api"
	if len(os.Args) == 2 && os.Args[1] == "mcp" {
		serviceName = "mcp"
	} else if len(os.Args) == 2 && os.Args[1] == "temporal-worker" {
		serviceName = "temporal-worker"
	}
	dir := os.Getenv("LAB_LOG_DIR")
	if dir == "" {
		dir = ".lab/logs"
	}
	logs := lablogs.Store{Dir: dir}
	destination, closeLog := logDestination(logs, serviceName)
	defer closeLog()
	telemetry.Configure(serviceName, destination)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if len(os.Args) == 2 && os.Args[1] == "mcp" {
		if err := mcptools.Server().Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
			slog.Error("process.failed", "error_type", fmt.Sprintf("%T", err))
			os.Exit(1)
		}
		return
	}

	if err := run(ctx, logs, serviceName == "temporal-worker"); err != nil {
		slog.Error("process.failed", "error_type", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
}

func logDestination(logs lablogs.Store, service string) (io.Writer, func()) {
	// The MCP child uses stderr for logs and stdout for protocol messages.
	// Its parent captures stderr under a separate filename.
	if service == "mcp" {
		return os.Stderr, func() {}
	}
	file, err := logs.Open(service)
	if err != nil {
		return os.Stderr, func() {}
	}
	return io.MultiWriter(os.Stderr, file), func() { _ = file.Close() }
}

func run(ctx context.Context, logs lablogs.Store, isWorker bool) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}

	// The same executable has a separate MCP mode. Its stdin and stdout carry
	// the protocol, while errors still go to the terminal via stderr.
	cmd := exec.Command(executable, "mcp")
	mcpLogSource := "api-mcp"
	if isWorker {
		mcpLogSource = "worker-mcp"
	}
	mcpOutput, closeMCPLog := logDestination(logs, mcpLogSource)
	defer closeMCPLog()
	cmd.Stderr = mcpOutput
	client := mcp.NewClient(&mcp.Implementation{Name: "lab-api", Version: "0.1.0"}, nil)
	startup, cancel := context.WithTimeout(ctx, 5*time.Second)
	session, err := client.Connect(startup, &mcp.CommandTransport{Command: cmd}, nil)
	cancel()
	if err != nil {
		return err
	}
	defer session.Close()

	model := ollama.Client{BaseURL: cfg.OllamaURL, Model: cfg.Model, HTTP: &http.Client{}}
	service := agent.Agent{Model: model, Tools: session, Checkpoints: &checkpoint.Postgres{URL: cfg.DatabaseURL}}
	// The API can still serve its other engines when Temporal is stopped.
	tc, err := temporalclient.NewLazyClient(temporalclient.Options{
		HostPort:           cfg.TemporalAddr,
		Logger:             temporallog.NewStructuredLogger(slog.Default().With("component", "temporal-sdk")),
		ContextPropagators: []workflow.ContextPropagator{telemetry.TemporalPropagation{}},
	})
	if err != nil {
		return err
	}
	defer tc.Close()
	// The worker runs as a separate process so it can stop while the API
	// keeps waiting for a result from Temporal.
	if isWorker {
		w := service.Worker(tc)
		if err := w.Start(); err != nil {
			return err
		}
		defer w.Stop()
		slog.Info("worker.started", "address", cfg.TemporalAddr)
		<-ctx.Done()
		return nil
	}
	service.Temporal = &agent.TemporalEngine{Client: tc, Timeout: cfg.Timeout}
	return runAPI(ctx, cfg, service, logs)
}

func runAPI(ctx context.Context, cfg config.Config, service agent.Agent, logs lablogs.Store) error {
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.Handler(service, cfg.Model, cfg.Timeout, httpapi.Diagnostics{ListTools: service.ListTools, RecentLogs: logs.Recent, Jobs: service.Temporal}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.Timeout + 15*time.Second,
		IdleTimeout:       time.Minute,
		BaseContext:       func(_ net.Listener) context.Context { return ctx },
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
	}()

	slog.Info("api.started", "address", cfg.Addr, "model", cfg.Model)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-stopped
	return nil
}
