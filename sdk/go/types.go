package wapi

import "encoding/json"

// Response shapes.
//
// Hand-written, unlike the TypeScript client's generated `types.gen.ts`, and the reason is worth
// stating rather than leaving as an inconsistency: there is no Go emitter for the OpenAPI
// document here, and several response schemas are deliberately loose — `/api/messages/{id}/info`
// returns a raw WhatsApp record whose shape is WhatsApp's, not ours. Those fields are
// json.RawMessage so the SDK does not pretend to model something it cannot.
//
// The consequence is honest: `ops/check-sdk-in-sync.mjs` proves every *operation* has a method in
// every language, but it cannot prove these structs still match. Keep them in step by hand when a
// response changes.

// Session is one WhatsApp session, as it appears in a list. Credentials are absent here.
type Session struct {
	ID                int      `json:"id"`
	Name              string   `json:"name"`
	PhoneNumber       string   `json:"phone_number"`
	Status            string   `json:"status"`
	AccountProtection bool     `json:"account_protection"`
	LogMessages       bool     `json:"log_messages"`
	WebhookURL        *string  `json:"webhook_url"`
	WebhookEnabled    bool     `json:"webhook_enabled"`
	WebhookEvents     []string `json:"webhook_events"`
	CreatedAt         string   `json:"created_at"`
	UpdatedAt         string   `json:"updated_at"`
}

// SessionDetail additionally carries the credential, in plaintext.
//
// That is the documented behaviour of the API being reproduced, which is why the key cannot be
// stored hash-only server-side. Treat this value as a secret: do not log it.
type SessionDetail struct {
	Session
	APIKey        *string `json:"api_key"`
	WebhookSecret *string `json:"webhook_secret"`
}

// SessionSettings are wapi's effective persisted controls, without session credentials.
type SessionSettings struct {
	AccountProtection    bool     `json:"account_protection"`
	LogMessages          bool     `json:"log_messages"`
	ReadIncomingMessages bool     `json:"read_incoming_messages"`
	AutoRejectCalls      bool     `json:"auto_reject_calls"`
	AlwaysOnline         bool     `json:"always_online"`
	IgnoreGroups         bool     `json:"ignore_groups"`
	IgnoreChannels       bool     `json:"ignore_channels"`
	IgnoreBroadcasts     bool     `json:"ignore_broadcasts"`
	ProxyURL             *string  `json:"proxy_url"`
	WebhookURL           *string  `json:"webhook_url"`
	WebhookEnabled       bool     `json:"webhook_enabled"`
	WebhookEvents        []string `json:"webhook_events"`
}

// SendResult is what a send returns. MsgID is wapi's own integer sequence, not WhatsApp's id —
// WhatsApp's is Key.ID on the record returned by Messages.Info.
type SendResult struct {
	MsgID  int64  `json:"msgId"`
	JID    string `json:"jid"`
	Status string `json:"status"`
}

// MessageKey identifies a message in WhatsApp's own terms.
//
// Used by MarkRead and React because those act on messages *someone else* sent, which have no
// MsgID. Take it straight from the webhook payload.
type MessageKey struct {
	ID          string `json:"id"`
	RemoteJID   string `json:"remoteJid"`
	FromMe      bool   `json:"fromMe,omitempty"`
	Participant string `json:"participant,omitempty"`
}

// MessageInfo is WhatsApp's record of a sent message.
//
// Two fields do not match what a send returns, and it is not a mistake: MessageTimestamp is a
// *string* because it is a protobuf int64, and Status is a *number* — 0 error, 1 pending, 2 sent,
// 3 delivered, 4 read — rather than the lifecycle word a send reports.
type MessageInfo struct {
	RemoteJID        *string         `json:"remoteJid"`
	ID               *string         `json:"id"`
	MsgID            int64           `json:"msgId"`
	Key              json.RawMessage `json:"key"`
	Message          json.RawMessage `json:"message"`
	MessageTimestamp string          `json:"messageTimestamp"`
	Status           int             `json:"status"`
}

// Contact is one entry in the address book.
//
// ImgURL and Status are always nil in a *list*: a picture and an "about" string are per-contact
// round-trips to WhatsApp, and a list call does not make N of them. Contacts.Get populates them.
type Contact struct {
	JID          string  `json:"jid"`
	ID           string  `json:"id"`
	Name         *string `json:"name"`
	Notify       *string `json:"notify"`
	VerifiedName *string `json:"verifiedName"`
	ImgURL       *string `json:"imgUrl"`
	Status       *string `json:"status"`
	PhoneNumber  *string `json:"phoneNumber"`
	LID          *string `json:"lid"`
}

// Participant carries both documented spellings at once, because the API emits both.
type Participant struct {
	JID          string  `json:"jid"`
	IsAdmin      bool    `json:"isAdmin"`
	IsSuperAdmin bool    `json:"isSuperAdmin"`
	ID           string  `json:"id"`
	Admin        *string `json:"admin"`
}

// Group likewise carries JID/ID and Name/Subject with the same values.
type Group struct {
	JID          string        `json:"jid"`
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Subject      string        `json:"subject"`
	ImgURL       *string       `json:"imgUrl"`
	Owner        *string       `json:"owner"`
	Creation     *int64        `json:"creation"`
	Desc         *string       `json:"desc"`
	Participants []Participant `json:"participants"`
}

// Pagination is the ?paginated=true envelope's metadata.
//
// TotalPages is ceil(Total/Limit); a consumer that validates it should use exactly that.
type Pagination struct {
	Page       int `json:"page"`
	Limit      int `json:"limit"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// ContactPage and GroupPage are what ?paginated=true returns — a *different shape* from the flat
// list, which is why Page and List are separate methods rather than one with a flag.
type ContactPage struct {
	Items      []Contact  `json:"items"`
	Pagination Pagination `json:"pagination"`
}

type GroupPage struct {
	Items      []Group    `json:"items"`
	Pagination Pagination `json:"pagination"`
}

// User is the WhatsApp identity behind a session key.
type User struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
	LID  *string `json:"lid"`
}

// ParticipantResult is one row of an add/remove response.
type ParticipantResult struct {
	Status  int    `json:"status"`
	JID     string `json:"jid"`
	Message string `json:"message"`
}
