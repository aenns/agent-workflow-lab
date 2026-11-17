// Package lablogs keeps a bounded local copy of the structured process logs.
package lablogs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const maxFileBytes = 512 * 1024
const maxEntries = 500

type Store struct{ Dir string }

var sources = []string{"api", "api-mcp", "temporal-worker", "worker-mcp", "api-typescript", "mcp-typescript", "mcp-worker-typescript", "temporal-worker-typescript"}

type Writer struct {
	mu   sync.Mutex
	path string
	file *os.File
	size int64
}

func (s Store) Open(source string) (*Writer, error) {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return nil, err
	}
	writer := &Writer{path: filepath.Join(s.Dir, source+".jsonl")}
	if err := writer.open(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *Writer) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	w.file, w.size = file, info.Size()
	return nil
}

func (w *Writer) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Console output remains available if the optional local copy fails.
	// Limit individual writes as well as the number of retained files.
	if w.file == nil || len(data) > maxFileBytes {
		return len(data), nil
	}
	if w.size+int64(len(data)) > maxFileBytes {
		// Rotate between writes so a complete JSON record stays in one file.
		if err := os.Rename(w.path, w.path+".previous"); err == nil {
			w.file.Close()
			w.file = nil
			if w.open() != nil {
				return len(data), nil
			}
		} else {
			return len(data), nil
		}
	}
	n, _ := w.file.Write(data)
	w.size += int64(n)
	return len(data), nil
}

func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (s Store) Recent() ([]json.RawMessage, error) {
	type entry struct {
		Time    time.Time `json:"time"`
		Message string    `json:"msg"`
		raw     json.RawMessage
	}

	entries := make([]entry, 0)
	for _, source := range sources {
		for _, suffix := range []string{".jsonl.previous", ".jsonl"} {
			data, err := tail(filepath.Join(s.Dir, source+suffix))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			for _, line := range bytes.Split(data, []byte{'\n'}) {
				var record entry
				if json.Unmarshal(line, &record) == nil && !record.Time.IsZero() && record.Message != "" {
					record.raw = line
					entries = append(entries, record)
				}
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Time.After(entries[j].Time) })
	result := make([]json.RawMessage, 0, min(len(entries), maxEntries))
	for _, record := range entries[:min(len(entries), maxEntries)] {
		result = append(result, record.raw)
	}
	return result, nil
}

func tail(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset := max(0, info.Size()-maxFileBytes)
	reader := io.NewSectionReader(file, offset, maxFileBytes)
	data, err := io.ReadAll(reader)
	if offset > 0 {
		// The first line may begin outside the retained window.
		_, data, _ = bytes.Cut(data, []byte{'\n'})
	}
	return data, err
}
