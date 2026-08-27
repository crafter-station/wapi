package wapi

import (
	"encoding/json"
	"fmt"
)

// Typed errors, one per failure envelope the API actually emits.
//
// There are three, and which one arrives tells you *where* the failure happened: a route handler
// sets "error", middleware sets "message", and the throttler emits {message, retry_after} with no
// "success" key at all. A client that reads only one of those keys loses half the failures — the
// single most common mistake made against this API.
//
// Every error carries Status and the raw Body, so nothing is hidden behind the abstraction: if
// the SDK has not modelled something, the response is still there.
//
// Use errors.As to branch:
//
//	var authErr *AuthError
//	if errors.As(err, &authErr) && authErr.WrongCredentialType() { ... }

// APIError is the base error. Status is 0 when the request never reached the server.
//
// Named APIError rather than Error because the derived types embed it: a field named Error would
// shadow the promoted Error() method and none of them would satisfy the error interface. That is
// a Go rule worth knowing before renaming anything here.
type APIError struct {
	Status  int
	Message string
	Body    json.RawMessage
}

func (e *APIError) Error() string { return fmt.Sprintf("wapi: %s (status %d)", e.Message, e.Status) }

// SessionNotConnected reports whether the session is not linked to WhatsApp.
//
// A 409 rather than a 5xx because nothing is broken — the number needs linking or reconnecting.
// Worth branching on: retrying will not help until somebody acts.
func (e *APIError) SessionNotConnected() bool { return e.Status == 409 }

// AuthError is a 401 or 403: missing, invalid, or the wrong *kind* of credential.
type AuthError struct{ APIError }

// WrongCredentialType reports whether the token was valid but of the wrong kind.
//
// A session key on an account-level route, or a Personal Access Token on a session-scoped one.
// That is a configuration mistake rather than a bad secret, and the two are worth telling apart.
func (e *AuthError) WrongCredentialType() bool { return e.Status == 403 }

// ValidationError is a 422. Fields maps each rejected field to its messages.
type ValidationError struct {
	APIError
	Fields map[string][]string
}

// RateLimitError is a 429.
//
// This body carries no "success" key at all, because the throttler short-circuits before the
// response envelope is applied. Reproducing that omission is deliberate.
type RateLimitError struct {
	APIError
	RetryAfter int
}

// UnavailableError is a 5xx, or a transport failure that never reached the server.
type UnavailableError struct{ APIError }

// Ambiguous reports whether the request may have been applied despite the failure.
//
// A timeout on a send is genuinely ambiguous — it says the *request* failed, not that the message
// went undelivered. Retrying blindly sends twice. Reconcile with Messages.Info instead.
func (e *UnavailableError) Ambiguous() bool { return e.Status == 0 || e.Status == 504 }

type envelope struct {
	ErrorMsg   string              `json:"error"`
	Message    string              `json:"message"`
	Errors     map[string][]string `json:"errors"`
	RetryAfter int                 `json:"retry_after"`
}

// errorFor builds the right error for a non-2xx response.
func errorFor(status int, body json.RawMessage) error {
	var env envelope
	_ = json.Unmarshal(body, &env) // a non-JSON body simply leaves the zero value

	// Both keys, always: handlers set "error", middleware sets "message".
	msg := env.ErrorMsg
	if msg == "" {
		msg = env.Message
	}
	if msg == "" {
		msg = fmt.Sprintf("request failed (%d)", status)
	}
	base := APIError{Status: status, Message: msg, Body: body}

	switch {
	case status == 401 || status == 403:
		return &AuthError{base}
	case status == 422:
		return &ValidationError{APIError: base, Fields: env.Errors}
	case status == 429:
		return &RateLimitError{APIError: base, RetryAfter: env.RetryAfter}
	case status == 0 || status >= 500:
		return &UnavailableError{base}
	default:
		return &base
	}
}
