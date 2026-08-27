package wapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Transport.
//
// Zero dependencies — net/http from the standard library, matching the TypeScript client's use of
// global fetch and the Python client's use of urllib. Something dropped into other people's
// projects should not drag a dependency tree behind it, and this is JSON in, JSON out, one header.

const (
	// DefaultBaseURL is the hosted deployment.
	DefaultBaseURL = "https://api.wapi.crafter.run"
	// DefaultTimeout is a per-request deadline. The failure mode of a WhatsApp call is silence,
	// not an error, so every request has one.
	DefaultTimeout = 30 * time.Second
)

type transport struct {
	apiKey  string
	baseURL string
	http    *http.Client
	headers map[string]string
}

// do performs one request.
//
// Returns the *whole* body rather than unwrapping "data", because this API has five different
// success envelopes: {success, data} for most routes, a bare {status} for /api/status, api_key at
// the top level for regenerate-key, publicUrl at the top level for upload and decrypt-media, and
// 204 with no body for delete. A single unwrap helper is wrong for four of those, so unwrapping
// happens per call site — see the resource files.
func (t *transport) do(
	ctx context.Context,
	method, path string,
	query url.Values,
	body any,
) (json.RawMessage, error) {
	target := t.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("wapi: encoding request: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return nil, fmt.Errorf("wapi: building request: %w", err)
	}
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	// Set last so a caller cannot override the credential through Headers.
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := t.http.Do(req)
	if err != nil {
		// Timeouts, DNS failures and refused connections never reached the server. Status 0
		// marks that, and UnavailableError.Ambiguous() is how a caller tells "definitely not
		// applied" from "possibly applied".
		return nil, &UnavailableError{APIError{Status: 0, Message: err.Error()}}
	}
	defer res.Body.Close()

	// 204 carries no body; unmarshalling it fails.
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &UnavailableError{APIError{Status: res.StatusCode, Message: err.Error()}}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, errorFor(res.StatusCode, raw)
	}
	return raw, nil
}

// unwrap pulls "data" out of the common envelope into v.
//
// Only for the routes that use it. The four that do not are handled explicitly at their call
// sites, which is deliberate: making the exception visible in the resource file beats a clever
// helper that silently returns the wrong thing.
func unwrap(raw json.RawMessage, v any) error {
	if raw == nil {
		return nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("wapi: decoding response: %w", err)
	}
	if env.Data == nil {
		return fmt.Errorf("wapi: response had no data field: %s", truncate(string(raw)))
	}
	if err := json.Unmarshal(env.Data, v); err != nil {
		return fmt.Errorf("wapi: decoding data: %w", err)
	}
	return nil
}

func truncate(s string) string {
	if len(s) <= 200 {
		return s
	}
	return s[:200] + "…"
}

// escape makes a value safe inside a path segment. Group JIDs contain characters that would
// otherwise change the route.
func escape(s string) string { return url.PathEscape(strings.TrimSpace(s)) }
