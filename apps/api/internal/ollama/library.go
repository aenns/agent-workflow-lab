package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/sync/errgroup"
)

const libraryOrigin = "https://ollama.com"
const registryOrigin = "https://registry.ollama.ai"

var ErrNoLocalManifest = errors.New("the tag has no downloadable local model manifest")

// Accept model tags from the Ollama library. Hostnames, URLs, community
// namespaces, and cloud tags are outside this local install flow.
var libraryTag = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}(:[a-zA-Z0-9][a-zA-Z0-9._-]{0,79})?$`)

func ValidLibraryTag(tag string) bool {
	family, variant, _ := strings.Cut(tag, ":")
	return libraryTag.MatchString(tag) && !strings.Contains(family, "..") &&
		!strings.HasSuffix(family, "-cloud") && variant != "cloud" && !strings.HasSuffix(variant, "-cloud")
}

type LibraryModel struct {
	Tag string
	URL string
}

func libraryClient() *http.Client {
	return &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(r *http.Request, _ []*http.Request) error {
		if r.URL.Scheme != "https" || (r.URL.Host != "ollama.com" && r.URL.Host != "registry.ollama.ai") {
			return http.ErrUseLastResponse
		}
		return nil
	}}
}

func SearchLibrary(ctx context.Context, query string) ([]LibraryModel, error) {
	client := libraryClient()
	results, err := libraryLinks(ctx, client, "/search?q="+url.QueryEscape(query)+"&c=tools")
	if err != nil {
		return nil, err
	}

	// An exact family search also shows versioned tags. Partial searches
	// still return families and their default tags.
	for _, result := range results {
		if result.Tag == query+":latest" {
			variants, err := libraryLinks(ctx, client, "/library/"+query+"/tags")
			if err == nil {
				seen := make(map[string]bool)
				merged := make([]LibraryModel, 0, len(variants)+len(results))
				for _, option := range append(variants, results...) {
					if !seen[option.Tag] {
						seen[option.Tag] = true
						merged = append(merged, option)
					}
				}
				return localModels(ctx, client, merged[:min(24, len(merged))])
			}
			break
		}
	}
	return localModels(ctx, client, results)
}

// Search results contain model families, including cloud-only families with
// no latest tag. Only offer candidates with an actual downloadable model layer.
func localModels(ctx context.Context, client *http.Client, candidates []LibraryModel) ([]LibraryModel, error) {
	var group errgroup.Group
	group.SetLimit(8)
	available := make([]bool, len(candidates))
	for i, candidate := range candidates {
		group.Go(func() error {
			err := checkManifest(ctx, client, candidate.Tag)
			available[i] = err == nil
			if errors.Is(err, ErrNoLocalManifest) {
				return nil
			}
			return err
		})
	}
	err := group.Wait()
	results := make([]LibraryModel, 0, len(candidates))
	for i, candidate := range candidates {
		if available[i] {
			results = append(results, candidate)
		}
	}
	if len(results) == 0 && err != nil {
		return nil, err
	}
	return results, nil
}

func CheckLocalManifest(ctx context.Context, tag string) error {
	return checkManifest(ctx, libraryClient(), tag)
}

func checkManifest(ctx context.Context, client *http.Client, tag string) error {
	if !ValidLibraryTag(tag) {
		return ErrNoLocalManifest
	}
	family, variant, tagged := strings.Cut(tag, ":")
	if !tagged {
		variant = "latest"
	}
	endpoint := registryOrigin + "/v2/library/" + family + "/manifests/" + variant
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return ErrNoLocalManifest
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Ollama registry returned HTTP %d", res.StatusCode)
	}
	var manifest struct {
		Layers []struct {
			MediaType string `json:"mediaType"`
			Size      int64  `json:"size"`
		} `json:"layers"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 256<<10)).Decode(&manifest); err != nil {
		return err
	}
	for _, layer := range manifest.Layers {
		if layer.MediaType == "application/vnd.ollama.image.model" && layer.Size > 0 {
			return nil
		}
	}
	return ErrNoLocalManifest
}

func libraryLinks(ctx context.Context, client *http.Client, path string) ([]LibraryModel, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, libraryOrigin+path, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Ollama Library returned HTTP %d", res.StatusCode)
	}
	return parseLibraryLinks(io.LimitReader(res.Body, 2<<20), 24), nil
}

func parseLibraryLinks(body io.Reader, limit int) []LibraryModel {
	// The public search page supplies model links. Read link attributes and
	// validate tags instead of depending on presentation classes or scraping text.
	tokens := html.NewTokenizer(body)
	results := make([]LibraryModel, 0)
	seen := make(map[string]bool)
	for len(results) < limit {
		switch tokens.Next() {
		case html.ErrorToken:
			return results
		case html.StartTagToken:
			token := tokens.Token()
			if token.Data != "a" {
				continue
			}
			for _, attr := range token.Attr {
				if attr.Key != "href" {
					continue
				}
				href := strings.TrimPrefix(attr.Val, libraryOrigin)
				tag, ok := strings.CutPrefix(href, "/library/")
				if !ok {
					continue
				}
				tag, err := url.PathUnescape(tag)
				if err != nil || !ValidLibraryTag(tag) {
					continue
				}
				if !strings.Contains(tag, ":") {
					tag += ":latest"
				}
				if !seen[tag] {
					seen[tag] = true
					results = append(results, LibraryModel{Tag: tag, URL: libraryOrigin + href})
				}
			}
		}
	}
	return results
}
