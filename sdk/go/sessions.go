package wapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// Sessions is account-level session management.
//
// Every method here needs a Personal Access Token, not a session key. Using the wrong kind
// returns 403 rather than 401 — see AuthError.WrongCredentialType.
type Sessions struct {
	t *transport

	// Connection is what you can do to a live socket.
	Connection *SessionConnection
	// Keys rotates credentials.
	Keys *SessionKeys
	// Logs reads what a session has sent.
	Logs *SessionLogs
}

type SessionConnection struct{ t *transport }
type SessionKeys struct{ t *transport }
type SessionLogs struct{ t *transport }

// List returns every session on the account. Credentials are not included.
func (s *Sessions) List(ctx context.Context) ([]Session, error) {
	raw, err := s.t.do(ctx, "GET", "/api/whatsapp-sessions", nil, nil)
	if err != nil {
		return nil, err
	}
	var out []Session
	return out, unwrap(raw, &out)
}

// Get returns one session, including its api_key and webhook_secret in plaintext.
func (s *Sessions) Get(ctx context.Context, sessionID int) (*SessionDetail, error) {
	raw, err := s.t.do(ctx, "GET", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID), nil, nil)
	if err != nil {
		return nil, err
	}
	var out SessionDetail
	return &out, unwrap(raw, &out)
}

// Create makes a session and issues its API key.
//
// Requires at least "name" and "phone_number". The response is the only place the key and webhook
// secret appear at creation time.
func (s *Sessions) Create(ctx context.Context, fields map[string]any) (*SessionDetail, error) {
	raw, err := s.t.do(ctx, "POST", "/api/whatsapp-sessions", nil, fields)
	if err != nil {
		return nil, err
	}
	var out SessionDetail
	return &out, unwrap(raw, &out)
}

// Update changes settings, webhook configuration or proxy.
//
// proxy_url must be a public hostname: IP addresses and private ranges are rejected, because the
// value becomes an outbound proxy for the server's own egress.
func (s *Sessions) Update(ctx context.Context, sessionID int, fields map[string]any) (*SessionDetail, error) {
	raw, err := s.t.do(ctx, "PUT", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID), nil, fields)
	if err != nil {
		return nil, err
	}
	var out SessionDetail
	return &out, unwrap(raw, &out)
}

// Delete removes a session and revokes its API key.
//
// Both at once: the key *is* the session, so deleting one destroys the other. Returns 204 with no
// body, which is why there is nothing to decode.
func (s *Sessions) Delete(ctx context.Context, sessionID int) error {
	_, err := s.t.do(ctx, "DELETE", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID), nil, nil)
	return err
}

// Connect begins linking, or reconnects from stored credentials.
//
// Returns immediately with a status and possibly a qrCode; it does not wait for the scan. Note the
// status is SCREAMING_CASE here and lowercase everywhere else — inherited from the API being
// reproduced. Poll Client.Status until it reads "connected"; the QR rotates while you wait.
func (c *SessionConnection) Connect(ctx context.Context, sessionID int) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "POST", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/connect", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Disconnect closes the socket without unlinking the device.
func (c *SessionConnection) Disconnect(ctx context.Context, sessionID int) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "POST", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/disconnect", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Restart reconnects a live session using its stored credentials.
//
// "message" at the top level — one of the six success envelopes, which is why nothing is
// unwrapped centrally.
func (c *SessionConnection) Restart(ctx context.Context, sessionID int) (string, error) {
	raw, err := c.t.do(ctx, "POST", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/restart", nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("wapi: decoding response: %w", err)
	}
	return out.Message, nil
}

// QRCode returns the current QR string for a session awaiting a scan.
func (c *SessionConnection) QRCode(ctx context.Context, sessionID int) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "GET", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/qrcode", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Regenerate issues a new API key, invalidating the old one immediately.
//
// Anything still using the previous key starts getting 401 the moment this returns — deployed
// apps, scripts, webhook consumers. There is no grace period.
//
// api_key arrives at the top level rather than under "data".
func (k *SessionKeys) Regenerate(ctx context.Context, sessionID int) (string, error) {
	raw, err := k.t.do(ctx, "POST", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/regenerate-key", nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		APIKey string `json:"api_key"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("wapi: decoding response: %w", err)
	}
	return out.APIKey, nil
}

// Activity returns one page of a session's lifecycle events.
//
// Distinct from the audit log, which records HTTP calls: this records status changes and
// restarts, which is what you want when a session misbehaves. PAT-scoped.
func (l *SessionLogs) Activity(ctx context.Context, sessionID, page, perPage int) (json.RawMessage, error) {
	q := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
	raw, err := l.t.do(ctx, "GET", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/session-logs", q, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Messages returns a paginated log of messages sent through a session.
//
// Uses Laravel's length-aware paginator — current_page, per_page, total — which is a *different*
// shape from the ?paginated=true mode on contacts and groups. Two unrelated pagination styles in
// one API is not a design anyone chose; it is what is being reproduced.
func (l *SessionLogs) Messages(ctx context.Context, sessionID, page int) (json.RawMessage, error) {
	q := url.Values{"page": {strconv.Itoa(page)}}
	raw, err := l.t.do(ctx, "GET", "/api/whatsapp-sessions/"+strconv.Itoa(sessionID)+"/message-logs", q, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}
