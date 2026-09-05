package wapi

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// Tokens manages Personal Access Tokens — the account-level credential. PAT-scoped.
//
// A wapi extension; WasenderAPI mints tokens only through its dashboard.
type Tokens struct{ t *transport }

// Audit reads the record of every call made with this account's credentials. PAT-scoped.
type Audit struct{ t *transport }

// Dispatches reads what the webhook worker sent for this session. Session-scoped.
type Dispatches struct{ t *transport }

// SandboxThread reads a sandbox's fake conversation. See Sandbox for driving one.
type SandboxThread struct{ t *transport }

// Create mints a token.
//
// The plaintext is returned exactly once — only the hash is stored, so there is no call that can
// show it again and List deliberately cannot.
func (t *Tokens) Create(ctx context.Context, name string) (json.RawMessage, error) {
	raw, err := t.t.do(ctx, "POST", "/api/tokens", nil, map[string]any{"name": name})
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// List returns every token on the account, including revoked ones. Never the secret.
func (t *Tokens) List(ctx context.Context) (json.RawMessage, error) {
	raw, err := t.t.do(ctx, "GET", "/api/tokens", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Revoke revokes a token and returns the confirmation message.
//
// Revoking the one you are holding works, and is how a machine logs itself out: the call
// authenticates first, and the credential stops working immediately afterwards. The row is marked
// revoked rather than deleted so the audit trail keeps pointing at something.
//
// message sits at the top level rather than under data, so this returns a string.
func (t *Tokens) Revoke(ctx context.Context, tokenID int) (string, error) {
	raw, err := t.t.do(ctx, "DELETE", "/api/tokens/"+strconv.Itoa(tokenID), nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	return out.Message, nil
}

// Page returns one page of calls, newest first.
//
// Account-scoped rather than session-scoped: calls made with a PAT — creating a session, rotating
// a key — have no session at all, so filing them under one would hide exactly the actions most
// worth auditing. Pass a non-zero sessionID to narrow to one.
func (a *Audit) Page(ctx context.Context, page, perPage, sessionID int) (json.RawMessage, error) {
	q := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
	if sessionID != 0 {
		q.Set("session_id", strconv.Itoa(sessionID))
	}
	raw, err := a.t.do(ctx, "GET", "/api/audit-logs", q, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Get returns one call, with the request and response bodies the list omits.
//
// Bodies are present only if body capture was enabled when the call happened, and the retention
// sweep nulls them after a week — so absent is normal rather than an error.
func (a *Audit) Get(ctx context.Context, auditLogID int) (json.RawMessage, error) {
	raw, err := a.t.do(ctx, "GET", "/api/audit-logs/"+strconv.Itoa(auditLogID), nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Page returns one page of webhook delivery attempts, most recent first.
//
// One row per event, updated in place across retries — so attempts climbing to five is the same
// row changing, not five rows appearing.
func (d *Dispatches) Page(ctx context.Context, page, perPage int) (json.RawMessage, error) {
	q := url.Values{"page": {strconv.Itoa(page)}, "per_page": {strconv.Itoa(perPage)}}
	raw, err := d.t.do(ctx, "GET", "/api/dispatches", q, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// List returns the sandbox conversation so far, oldest first — both directions.
//
// Held in the gateway's memory and bounded at 200 entries, so there is no pagination and a
// gateway restart returns the sandbox to its fixtures.
func (s *SandboxThread) List(ctx context.Context) (json.RawMessage, error) {
	raw, err := s.t.do(ctx, "GET", "/api/sandbox/thread", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}
