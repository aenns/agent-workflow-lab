package ollama

import (
	"slices"
	"strings"
	"testing"
)

func TestParseLibraryLinks(t *testing.T) {
	page := strings.NewReader(`
		<a href="/library/qwen3.5">Qwen</a>
		<a href="/library/qwen3.5:latest">Duplicate</a>
		<a href="/library/qwen3.5:9b">9B</a>
		<a href="/library/qwen3.5:9b-cloud">Cloud</a>
		<a href="/library/qwen3.5/tags">Tag list</a>
		<a href="https://example.com/library/fake">External</a>
		<a href="/user/model">Community</a>`)
	got := parseLibraryLinks(page, 24)
	want := []LibraryModel{
		{Tag: "qwen3.5:latest", URL: "https://ollama.com/library/qwen3.5"},
		{Tag: "qwen3.5:9b", URL: "https://ollama.com/library/qwen3.5:9b"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
