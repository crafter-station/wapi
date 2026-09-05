// Package wapi is a client for the wapi WhatsApp REST API.
//
//	client := wapi.New(os.Getenv("WAPI_KEY"))
//	res, err := client.Messages.Send(ctx, "+51999888777", wapi.Text("hello"))
//
// Zero dependencies — net/http only. The method surface is hand-written rather than generated:
// the API's operationIds are mechanical path transliterations, so a generator would produce
// PostApiWhatsappSessionsWhatsappSessionRegenerateKey. See sdk/README.md for the shape every
// client here follows, and ops/check-sdk-in-sync.mjs for what keeps them honest.
package wapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Client is the entry point.
//
// The api key is either a session API key or a Personal Access Token, and they are not
// interchangeable: messaging, contacts and groups take the session key, while creating or
// deleting sessions takes a PAT. Using the wrong one returns 403, not 401.
type Client struct {
	t *transport

	Sessions *Sessions
	Messages *Messages
	Contacts *Contacts
	Groups   *Groups
	// Sandbox is a wapi extension: a fake number on a fake WhatsApp.
	Sandbox *Sandbox
	// SandboxThread reads a sandbox conversation, as opposed to driving one.
	SandboxThread *SandboxThread
	// Tokens manages Personal Access Tokens. A wapi extension — PAT-scoped.
	Tokens *Tokens
	// Audit reads every call made with this account's credentials. A wapi extension — PAT-scoped.
	Audit *Audit
	// Dispatches reads webhook delivery attempts for this session. A wapi extension.
	Dispatches *Dispatches
}

// Option configures a Client.
type Option func(*transport)

// WithBaseURL points the client at a different deployment.
func WithBaseURL(url string) Option {
	// Trailing slashes would produce "//api/...", which some proxies redirect and others 404.
	return func(t *transport) { t.baseURL = strings.TrimRight(url, "/") }
}

// WithTimeout sets the per-request deadline.
func WithTimeout(d time.Duration) Option {
	return func(t *transport) { t.http.Timeout = d }
}

// WithHTTPClient swaps the underlying client — a proxy, a test double, an instrumented wrapper.
func WithHTTPClient(c *http.Client) Option {
	return func(t *transport) { t.http = c }
}

// WithHeader adds a header to every request. It cannot override Authorization.
func WithHeader(name, value string) Option {
	return func(t *transport) { t.headers[name] = value }
}

// New builds a client.
func New(apiKey string, opts ...Option) *Client {
	t := &transport{
		apiKey:  apiKey,
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: DefaultTimeout},
		headers: map[string]string{},
	}
	for _, opt := range opts {
		opt(t)
	}
	return &Client{
		t:        t,
		Sessions: &Sessions{t: t, Connection: &SessionConnection{t}, Keys: &SessionKeys{t}, Logs: &SessionLogs{t}},
		Messages: &Messages{t: t, Media: &Media{t}},
		Contacts: &Contacts{t: t, LID: &LIDResolver{t}},
		Groups:   &Groups{t: t, Participants: &GroupParticipants{t}},
		Sandbox:  &Sandbox{t},

		SandboxThread: &SandboxThread{t},
		Tokens:        &Tokens{t},
		Audit:         &Audit{t},
		Dispatches:    &Dispatches{t},
	}
}

// SendPresence tells a chat you are typing, recording, or online.
//
// One of "unavailable", "available", "composing", "recording", "paused". Fire-and-forget by
// nature: WhatsApp acknowledges nothing, so a nil error means the frame left, not that anybody
// saw it.
func (c *Client) SendPresence(ctx context.Context, jid, presenceType string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "POST", "/api/send-presence-update", nil,
		map[string]any{"jid": jid, "type": presenceType})
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// FetchUsername returns a contact's WhatsApp @username, when there is one.
//
// Null far more often than not: WhatsApp volunteers a username only for accounts that have set
// one, and offers no way to ask.
func (c *Client) FetchUsername(ctx context.Context, identifier string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "GET", "/api/fetch-username/"+escape(identifier), nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Status returns the connection state of the session this key belongs to.
//
// A bare {"status": ...} with no "success" wrapper — one of six success envelopes, and the
// reason this client does not unwrap "data" centrally.
func (c *Client) Status(ctx context.Context) (string, error) {
	raw, err := c.t.do(ctx, "GET", "/api/status", nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("wapi: decoding response: %w", err)
	}
	return out.Status, nil
}

// User returns the WhatsApp identity behind the session key, including its LID.
func (c *Client) User(ctx context.Context) (*User, error) {
	raw, err := c.t.do(ctx, "GET", "/api/user", nil, nil)
	if err != nil {
		return nil, err
	}
	var out User
	return &out, unwrap(raw, &out)
}
