package wapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Messages covers sending, reading and media. Session API key.
type Messages struct {
	t *transport

	// Media handles upload and inbound decryption.
	Media *Media
}

type Media struct{ t *transport }

// SendOption sets one field on a send. Which field you set decides what is sent — there is no
// separate route for images or groups — and setting two content fields is an error rather than a
// silent preference.
type SendOption func(map[string]any)

func Text(text string) SendOption      { return func(m map[string]any) { m["text"] = text } }
func ImageURL(url string) SendOption   { return func(m map[string]any) { m["imageUrl"] = url } }
func VideoURL(url string) SendOption   { return func(m map[string]any) { m["videoUrl"] = url } }
func AudioURL(url string) SendOption   { return func(m map[string]any) { m["audioUrl"] = url } }
func StickerURL(url string) SendOption { return func(m map[string]any) { m["stickerUrl"] = url } }

// DocumentURL sends a file. FileName is separate because the API takes it separately.
func DocumentURL(url, fileName string) SendOption {
	return func(m map[string]any) { m["documentUrl"], m["fileName"] = url, fileName }
}

// ReplyTo quotes an earlier message by its wapi msgId — not WhatsApp's string id.
func ReplyTo(msgID int64) SendOption { return func(m map[string]any) { m["replyTo"] = msgID } }

// Mentions tags participants in a group message.
func Mentions(numbers ...string) SendOption {
	return func(m map[string]any) { m["mentions"] = numbers }
}

// Field sets any other documented field — location, poll, contact — without the SDK having to
// model every shape the API accepts.
func Field(name string, value any) SendOption {
	return func(m map[string]any) { m[name] = value }
}

// Send sends a message. One endpoint for every type.
//
// "to" may be a phone number, a WhatsApp JID, or a group JID ending @g.us.
//
// A timeout here is ambiguous. It says the request failed, not that the message went undelivered —
// retrying blindly sends twice. Check UnavailableError.Ambiguous and reconcile with Info instead.
func (m *Messages) Send(ctx context.Context, to string, opts ...SendOption) (*SendResult, error) {
	body := map[string]any{"to": to}
	for _, opt := range opts {
		opt(body)
	}
	raw, err := m.t.do(ctx, "POST", "/api/send-message", nil, body)
	if err != nil {
		return nil, err
	}
	var out SendResult
	return &out, unwrap(raw, &out)
}

// Info fetches a sent message by its integer msgId.
//
// Returns WhatsApp's own record, so MessageTimestamp is a string and Status a number — see the
// MessageInfo doc comment.
func (m *Messages) Info(ctx context.Context, msgID int64) (*MessageInfo, error) {
	raw, err := m.t.do(ctx, "GET", "/api/messages/"+strconv.FormatInt(msgID, 10)+"/info", nil, nil)
	if err != nil {
		return nil, err
	}
	var out MessageInfo
	return &out, unwrap(raw, &out)
}

// Edit changes the text of a message you sent.
//
// WhatsApp allows this only for a short window afterwards and gives no way to ask how long is
// left, so a refusal is an ordinary outcome. The edit is a new message superseding the old one,
// so the response carries a fresh key alongside the original msgId.
func (m *Messages) Edit(ctx context.Context, msgID int64, text string) (json.RawMessage, error) {
	raw, err := m.t.do(ctx, "PUT", "/api/messages/"+strconv.FormatInt(msgID, 10), nil,
		map[string]any{"text": text})
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Delete deletes a message for everyone. Same short window as editing.
//
// This endpoint puts message at the top level rather than under data, so it returns the
// confirmation string rather than unwrapping.
func (m *Messages) Delete(ctx context.Context, msgID int64) (string, error) {
	raw, err := m.t.do(ctx, "DELETE", "/api/messages/"+strconv.FormatInt(msgID, 10), nil, nil)
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

// Resend retries a message whose status is "failed".
//
// Only failed messages, deliberately: a send that timed out is recorded as in_progress because
// nobody knows whether it arrived, and resending one of those is how a customer gets the same
// message twice.
func (m *Messages) Resend(ctx context.Context, msgID int64) (string, error) {
	raw, err := m.t.do(ctx, "POST", "/api/messages/"+strconv.FormatInt(msgID, 10)+"/resend", nil, nil)
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

// MarkRead marks a received message as read.
//
// Takes the WhatsApp key rather than a msgId: inbound messages have no msgId, which only ever
// identifies something you sent. Take the key from the webhook payload.
func (m *Messages) MarkRead(ctx context.Context, key MessageKey) error {
	_, err := m.t.do(ctx, "POST", "/api/messages/read", nil, map[string]any{"key": key})
	return err
}

// React reacts to a message.
//
// A wapi extension, not part of the WasenderAPI interface — they report reactions over webhooks
// but offer no way to send one. Feature-detect if you target both.
func (m *Messages) React(ctx context.Context, key MessageKey, emoji string) error {
	_, err := m.t.do(ctx, "POST", "/api/messages/react", nil, map[string]any{
		"key": key, "emoji": emoji,
	})
	return err
}

// Unreact removes a reaction. An empty emoji is WhatsApp's convention, not a separate endpoint.
func (m *Messages) Unreact(ctx context.Context, key MessageKey) error {
	return m.React(ctx, key, "")
}

// Upload stores bytes and returns a permanent URL to pass to Send.
//
// Permanent is the point: media is fetched server-side at send time, so an expiring link would
// stop working between upload and delivery. Caps at 16 MB.
//
// publicUrl sits at the top level, not under "data".
func (md *Media) Upload(ctx context.Context, content []byte, mimetype, fileName string) (string, error) {
	body := map[string]any{
		"base64":   base64.StdEncoding.EncodeToString(content),
		"mimetype": mimetype,
	}
	if fileName != "" {
		body["fileName"] = fileName
	}
	// Uploads are slower than reads; the client default is too tight for a large file.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	raw, err := md.t.do(ctx, "POST", "/api/upload", nil, body)
	if err != nil {
		return "", err
	}
	var out struct {
		PublicURL string `json:"publicUrl"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("wapi: decoding response: %w", err)
	}
	return out.PublicURL, nil
}

// Decrypt turns an inbound encrypted media node into a URL valid for one hour.
//
// Inbound media arrives as a CDN link plus a mediaKey; the bytes are useless without decryption,
// and only the session holding the keys can do it. Pass the message object from the webhook.
func (md *Media) Decrypt(ctx context.Context, message json.RawMessage) (string, error) {
	body := map[string]any{"data": map[string]any{"messages": map[string]any{"message": message}}}
	raw, err := md.t.do(ctx, "POST", "/api/decrypt-media", nil, body)
	if err != nil {
		return "", err
	}
	var out struct {
		PublicURL string `json:"publicUrl"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("wapi: decoding response: %w", err)
	}
	return out.PublicURL, nil
}
