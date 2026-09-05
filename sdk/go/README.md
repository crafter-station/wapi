# wapi — Go client

Zero dependencies. `net/http` only. Go 1.22+.

## Install

Go resolves subdirectory modules natively, so this is an ordinary `go get` — no vendoring, unlike
the TypeScript client:

```bash
go get github.com/crafter-station/wapi/sdk/go@v0.2.0
```

Pin a tag for anything you deploy; `@main` moves. Note the tag Go resolves is `sdk/go/v0.2.0`,
not `v0.2.0` — a module in a subdirectory takes a tag prefixed with its path, and the repository
carries both so `@v0.2.0` above works as written.

```go
import wapi "github.com/crafter-station/wapi/sdk/go"

client := wapi.New(os.Getenv("WAPI_KEY"))
res, err := client.Messages.Send(ctx, "+51999888777", wapi.Text("hello"))
```

## Two credentials, not interchangeable

| Token | Use for |
| --- | --- |
| **Session API key** | messaging, contacts, groups, media, status |
| **Personal Access Token** | creating, updating and deleting sessions; rotating keys |

The wrong one returns **`403`, not `401`** — valid token, wrong kind. That is a configuration
mistake rather than a bad secret, so it has its own predicate:

```go
var authErr *wapi.AuthError
if errors.As(err, &authErr) && authErr.WrongCredentialType() {
    // reach for a PAT
}
```

## The surface

```go
client.Status(ctx)
client.User(ctx)
client.SendPresence(ctx, jid, "composing")            // typing indicator
client.FetchUsername(ctx, jid)                        // usually null

client.Sessions.List(ctx)                             // PAT
client.Sessions.Connection.Connect(ctx, 3)
client.Sessions.Keys.Regenerate(ctx, 3)               // old key dies immediately
client.Sessions.Logs.Messages(ctx, 3, 1)              // what was sent
client.Sessions.Logs.Activity(ctx, 3, 1, 15)          // what happened to the connection

client.Messages.Send(ctx, to, wapi.Text("hi"))
client.Messages.Send(ctx, to, wapi.ImageURL(u), wapi.Text("caption"))
client.Messages.Info(ctx, 100024)
client.Messages.Edit(ctx, 100024, "corrected")        // short window only
client.Messages.Delete(ctx, 100024)                   // returns a string
client.Messages.Resend(ctx, 100024)                   // failed messages only
client.Messages.React(ctx, key, "👍")                 // wapi extension
client.Messages.Media.Upload(ctx, bytes, "image/png", "photo.png")

client.Contacts.List(ctx)                             // flat list
client.Contacts.Page(ctx, 1, 50)                      // different shape — see below
client.Contacts.Save(ctx, jid, "Ada")                 // stored by wapi, not on the phone
client.Contacts.Block(ctx, number)                    // and Unblock
client.Contacts.Picture(ctx, number)                  // imgUrl is usually null
client.Contacts.LID.ToPhone(ctx, lid)                 // "" when unknown

client.Groups.Metadata(ctx, jid)
client.Groups.Leave(ctx, jid)
client.Groups.InviteLink(ctx, jid)                    // returns a string
client.Groups.ByInvite(ctx, code)                     // and AcceptInvite
client.Groups.UpdateSettings(ctx, jid, map[string]any{"subject": "New name"})
client.Groups.Participants.Add(ctx, jid, []string{"+51..."})
client.Groups.Participants.Update(ctx, jid, []string{"+51..."}, "promote")

client.Sandbox.CreateSession(ctx, "dev")              // wapi extension
```

Send options are functional rather than a struct, so setting two content fields is visible at the
call site. `wapi.Field(name, value)` covers documented fields the SDK does not model.

## Things that will surprise you

**`List` and `Page` are separate methods.** `?paginated=true` returns a *different shape* —
`{items, pagination}` rather than a bare array. One method with a flag would decode into the
wrong type and yield nothing.

**Nothing unwraps `data` centrally.** Six success envelopes: `Status` returns a bare
`{"status": …}`, uploads put `publicUrl` at the top level, `Groups.InviteLink` puts `inviteLink`
there, `Messages.Delete` and `.Resend` put `message` there, and `Sessions.Delete` returns `204`
with no body. That is why a few methods return a plain `string` instead of `json.RawMessage`.

**A timeout on a send is ambiguous.** It means the request failed, not that the message went
undelivered. Check `UnavailableError.Ambiguous()` and reconcile with `Messages.Info` — never
resend blindly.

**Promote/demote reports differently from add/remove.** `Participants.Add` and `.Remove` return a
per-participant list of `{status, jid, message}`; `Participants.Update` returns
`{"participants": [jid]}` with no status at all. On the latter, compare what you sent against what
comes back to notice a partial failure. Theirs, not ours.

**`FetchUsername` and `Contacts.Picture` are usually empty.** WhatsApp volunteers a username or a
picture only when the account has one and offers no way to ask, so null is the ordinary answer —
inside a `200`, not a `404`.

**Editing and deleting only work briefly.** WhatsApp allows both for a short window after sending
and gives no way to ask how long is left, so a refusal is expected rather than a bug.

**Response structs are hand-written**, unlike the TypeScript client's generated types. There is
no Go emitter for the OpenAPI document, and several responses are deliberately loose — `Info`
returns WhatsApp's own record — so those fields are `json.RawMessage` rather than a pretend
model. The drift guard proves every *operation* has a method; it cannot prove these structs still
match, so keep them in step by hand.

## Errors

All carry `Status` and the raw `Body`. Match with `errors.As`.

| Type | When |
| --- | --- |
| `*AuthError` | 401, 403 — `WrongCredentialType()` separates them |
| `*ValidationError` | 422 — `Fields` maps field to messages |
| `*RateLimitError` | 429 — `RetryAfter` in seconds |
| `*UnavailableError` | 5xx or transport failure — `Ambiguous()` |
| `*APIError` | anything else; `SessionNotConnected()` covers the 409 |
