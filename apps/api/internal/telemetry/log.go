// Package telemetry defines the log fields and correlation carriers used by the lab.
package telemetry

import (
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const Header = "X-Correlation-ID"
const CorrelationField = "correlation_id"

type correlationKey struct{}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

func Configure(service string, destination io.Writer) {
	var level slog.Level
	if level.UnmarshalText([]byte(os.Getenv("LOG_LEVEL"))) != nil {
		level = slog.LevelInfo
	}
	handler := slog.NewJSONHandler(destination, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == slog.LevelKey {
				return slog.String(slog.LevelKey, strings.ToLower(attr.Value.String()))
			}
			return attr
		},
	})
	slog.SetDefault(slog.New(handler).With("service", service))
}

func WithCorrelation(ctx context.Context, id string) context.Context {
	if !validID.MatchString(id) {
		return ctx
	}
	return context.WithValue(ctx, correlationKey{}, id)
}

func Correlation(ctx context.Context) string {
	id, _ := ctx.Value(correlationKey{}).(string)
	return id
}

func Logger(ctx context.Context, component string) *slog.Logger {
	logger := slog.Default().With("component", component)
	if id := Correlation(ctx); id != "" {
		logger = logger.With(CorrelationField, id)
	}
	return logger
}

// HTTP accepts a bounded client ID or generates one, then carries it in the
// context and echoes it on every response, including validation errors.
func HTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(Header)
		if !validID.MatchString(id) {
			id = rand.Text()
		}
		ctx := WithCorrelation(r.Context(), id)
		w.Header().Set(Header, id)
		response := &statusWriter{ResponseWriter: w}
		start := time.Now()
		// Downstream routers receive the same validated value we send back.
		r = r.Clone(ctx)
		r.Header.Set(Header, id)
		next.ServeHTTP(response, r)
		status := response.status
		if status == 0 {
			status = http.StatusOK
		}
		if r.URL.Path == "/api/logs" || (r.Method == http.MethodGet && r.URL.Path == "/api/jobs") {
			return // Quiet polling should not fill the local logs.
		}
		Logger(ctx, "http").Info("http.request.completed",
			"method", r.Method, "route", r.Pattern, "status", status, "duration_ms", time.Since(start).Milliseconds())
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 && status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}
