package wapi

import (
	"context"
	"encoding/json"
)

// Sandbox is a fake number on a fake WhatsApp.
//
// A wapi extension, not part of the WasenderAPI interface. It exists because linking a real
// number is the highest-friction step in this product and the one that carries a ban risk, so you
// should not have to do it to find out whether your integration works.
//
// A sandbox session goes through the same routes and the same code as a real one: it pairs itself
// after a few seconds, has a small deterministic directory, accepts sends and can be made to
// receive them. Its number lives under ITU country code 999, which is unassigned and cannot route
// anywhere.
//
// Two differences from production, deliberate and worth knowing before tuning anything against
// them: account_protection pacing is ignored, so sends return immediately where production would
// wait five seconds; and decrypt-media returns a fixed PNG rather than real media.
type Sandbox struct{ t *transport }

// CreateSession creates a sandbox session. Requires a Personal Access Token.
//
// The number is not yours to choose — it is derived from the session id, so it cannot collide
// with a real one. The response carries the session's own API key, which is what every other call
// here uses.
func (s *Sandbox) CreateSession(ctx context.Context, name string) (*SessionDetail, error) {
	raw, err := s.t.do(ctx, "POST", "/api/sandbox/sessions", nil, map[string]any{"name": name})
	if err != nil {
		return nil, err
	}
	var out SessionDetail
	return &out, unwrap(raw, &out)
}

// Inbound fabricates a message, as if somebody had written to this number.
//
// The reason the sandbox exists. It travels the ordinary pipeline, so the webhook reaching your
// handler is signed exactly as a real one. Use a session key here, not a PAT.
//
// An empty from defaults to the session's first derived contact, so the common case needs no
// sender and the message is still attributable.
func (s *Sandbox) Inbound(ctx context.Context, text, from string) (json.RawMessage, error) {
	body := map[string]any{"text": text}
	if from != "" {
		body["from"] = from
	}
	raw, err := s.t.do(ctx, "POST", "/api/sandbox/inbound", nil, body)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Scan finishes pairing immediately rather than waiting for the fake QR to resolve itself.
//
// Only useful when deliberately testing the waiting state — a sandbox session connects on its own
// a few seconds after Sessions.Connection.Connect.
func (s *Sandbox) Scan(ctx context.Context) error {
	_, err := s.t.do(ctx, "POST", "/api/sandbox/scan", nil, map[string]any{})
	return err
}
