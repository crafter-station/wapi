package wapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
)

// Contacts covers the address book and identity resolution. Session API key.
type Contacts struct {
	t *transport

	// LID resolves between phone numbers and WhatsApp's LID identities.
	LID *LIDResolver
}

// LIDResolver maps between the two identity forms.
//
// They are not derivable from one another. Never guess a phone number from a LID.
type LIDResolver struct{ t *transport }

// Groups covers groups and their participants.
type Groups struct {
	t *transport

	// Participants adds and removes members.
	Participants *GroupParticipants
}

type GroupParticipants struct{ t *transport }

// List returns every known contact as a flat list.
func (c *Contacts) List(ctx context.Context) ([]Contact, error) {
	raw, err := c.t.do(ctx, "GET", "/api/contacts", nil, nil)
	if err != nil {
		return nil, err
	}
	var out []Contact
	return out, unwrap(raw, &out)
}

// Page returns one page of contacts.
//
// A separate method rather than a flag on List, because ?paginated=true returns a *different
// shape* — {items, pagination} instead of a bare list. One method with a flag would let a caller
// decode the wrong thing and get nothing.
//
// limit defaults to 20 server-side and caps at 500.
func (c *Contacts) Page(ctx context.Context, page, limit int) (*ContactPage, error) {
	q := url.Values{
		"paginated": {"true"},
		"page":      {strconv.Itoa(page)},
		"limit":     {strconv.Itoa(limit)},
	}
	raw, err := c.t.do(ctx, "GET", "/api/contacts", q, nil)
	if err != nil {
		return nil, err
	}
	var out ContactPage
	return &out, unwrap(raw, &out)
}

// Get returns one contact. Unlike a list entry, ImgURL and Status can be populated here.
func (c *Contacts) Get(ctx context.Context, phoneNumber string) (*Contact, error) {
	raw, err := c.t.do(ctx, "GET", "/api/contacts/"+escape(phoneNumber), nil, nil)
	if err != nil {
		return nil, err
	}
	var out Contact
	return &out, unwrap(raw, &out)
}

// OnWhatsApp reports whether a number is registered.
func (c *Contacts) OnWhatsApp(ctx context.Context, identifier string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "GET", "/api/on-whatsapp/"+escape(identifier), nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Save stores a contact's name in this session's address book.
//
// wapi keeps this itself — WhatsApp exposes no address-book write — so the name is visible to
// List and Get but never reaches the linked phone.
func (c *Contacts) Save(ctx context.Context, jid string, fullName string) (json.RawMessage, error) {
	body := map[string]any{"jid": jid}
	if fullName != "" {
		body["fullName"] = fullName
	}
	raw, err := c.t.do(ctx, "PUT", "/api/contacts", nil, body)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Block blocks a contact.
func (c *Contacts) Block(ctx context.Context, phoneNumber string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "POST", "/api/contacts/"+escape(phoneNumber)+"/block", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Unblock unblocks a contact.
func (c *Contacts) Unblock(ctx context.Context, phoneNumber string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "POST", "/api/contacts/"+escape(phoneNumber)+"/unblock", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// Picture returns a contact's profile picture URL.
//
// imgUrl is null more often than not — most accounts have no picture, or show it only to their
// own contacts. That is a success with nothing in it, not an error.
func (c *Contacts) Picture(ctx context.Context, phoneNumber string) (json.RawMessage, error) {
	raw, err := c.t.do(ctx, "GET", "/api/contacts/"+escape(phoneNumber)+"/picture", nil, nil)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	return out, unwrap(raw, &out)
}

// FromPhone resolves a phone number to its LID.
func (l *LIDResolver) FromPhone(ctx context.Context, phoneNumber string) (string, error) {
	raw, err := l.t.do(ctx, "GET", "/api/lid-from-pn/"+escape(phoneNumber), nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		LID string `json:"lid"`
	}
	return out.LID, unwrap(raw, &out)
}

// ToPhone resolves a LID back to a phone number where known.
//
// Returns ("", nil) on a 404, which is a normal outcome rather than an error: not every LID has a
// known mapping, and there is nothing to retry.
func (l *LIDResolver) ToPhone(ctx context.Context, lid string) (string, error) {
	raw, err := l.t.do(ctx, "GET", "/api/pn-from-lid/"+escape(lid), nil, nil)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == 404 {
			return "", nil
		}
		return "", err
	}
	var out struct {
		PN string `json:"pn"`
	}
	return out.PN, unwrap(raw, &out)
}

// List returns every group this session belongs to.
func (g *Groups) List(ctx context.Context) ([]Group, error) {
	raw, err := g.t.do(ctx, "GET", "/api/groups", nil, nil)
	if err != nil {
		return nil, err
	}
	var out []Group
	return out, unwrap(raw, &out)
}

// Page returns one page of groups. Separate from List for the same reason as contacts.
func (g *Groups) Page(ctx context.Context, page, limit int) (*GroupPage, error) {
	q := url.Values{
		"paginated": {"true"},
		"page":      {strconv.Itoa(page)},
		"limit":     {strconv.Itoa(limit)},
	}
	raw, err := g.t.do(ctx, "GET", "/api/groups", q, nil)
	if err != nil {
		return nil, err
	}
	var out GroupPage
	return &out, unwrap(raw, &out)
}

// Metadata returns subject, description, owner and participants.
func (g *Groups) Metadata(ctx context.Context, groupJID string) (*Group, error) {
	raw, err := g.t.do(ctx, "GET", "/api/groups/"+escape(groupJID)+"/metadata", nil, nil)
	if err != nil {
		return nil, err
	}
	var out Group
	return &out, unwrap(raw, &out)
}

// Create makes a group.
func (g *Groups) Create(ctx context.Context, subject string, participants []string) (*Group, error) {
	raw, err := g.t.do(ctx, "POST", "/api/groups", nil, map[string]any{
		"name": subject, "participants": participants,
	})
	if err != nil {
		return nil, err
	}
	var out Group
	return &out, unwrap(raw, &out)
}

// List returns a group's participants.
func (p *GroupParticipants) List(ctx context.Context, groupJID string) ([]Participant, error) {
	raw, err := p.t.do(ctx, "GET", "/api/groups/"+escape(groupJID)+"/participants", nil, nil)
	if err != nil {
		return nil, err
	}
	var out []Participant
	return out, unwrap(raw, &out)
}

// Add adds participants.
//
// Acts on real people in a real chat and is not undoable — everyone in the group sees it. Worth a
// confirmation step in anything user-facing.
func (p *GroupParticipants) Add(ctx context.Context, groupJID string, participants []string) ([]ParticipantResult, error) {
	raw, err := p.t.do(ctx, "POST", "/api/groups/"+escape(groupJID)+"/participants/add", nil,
		map[string]any{"participants": participants})
	if err != nil {
		return nil, err
	}
	var out []ParticipantResult
	return out, unwrap(raw, &out)
}

// Remove removes participants. Same caveat as Add, more so.
func (p *GroupParticipants) Remove(ctx context.Context, groupJID string, participants []string) ([]ParticipantResult, error) {
	raw, err := p.t.do(ctx, "POST", "/api/groups/"+escape(groupJID)+"/participants/remove", nil,
		map[string]any{"participants": participants})
	if err != nil {
		return nil, err
	}
	var out []ParticipantResult
	return out, unwrap(raw, &out)
}
