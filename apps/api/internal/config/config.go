package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr, OllamaURL, Model string
	Timeout                time.Duration
	DatabaseURL            string
	TemporalAddr           string
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func Load() (Config, error) {
	cfg := Config{
		Addr:         env("API_ADDR", "127.0.0.1:8080"),
		OllamaURL:    strings.TrimRight(env("OLLAMA_URL", "http://127.0.0.1:11434"), "/"),
		Model:        env("OLLAMA_MODEL", "qwen3:14b"),
		TemporalAddr: env("TEMPORAL_ADDR", "127.0.0.1:7233"),
		DatabaseURL:  env("DATABASE_URL", "postgres://lab:lab@127.0.0.1:54329/lab?sslmode=disable&connect_timeout=3"),
	}
	u, err := url.Parse(cfg.OllamaURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return Config{}, fmt.Errorf("OLLAMA_URL must be an HTTP(S) base URL")
	}
	cfg.Timeout, err = time.ParseDuration(env("CHAT_TIMEOUT", "3m"))
	if err != nil || cfg.Timeout <= 0 || cfg.Timeout > time.Hour {
		return Config{}, fmt.Errorf("CHAT_TIMEOUT must be a positive duration up to 1h")
	}
	return cfg, nil
}
