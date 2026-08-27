# wapi — Go client

Zero dependencies. `net/http` only. Go 1.22+.

## Install

Go resolves subdirectory modules natively, so this is an ordinary `go get` — no vendoring, unlike
the TypeScript client:

```bash
go get github.com/crafter-station/wapi/sdk/go@main
```

Pin a commit for anything you deploy; `@main` moves.

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

client.Sessions.List(ctx)                             // PAT
client.Sessions.Connection.Connect(ctx, 3)
client.Sessions.Keys.Regenerate(ctx, 3)               // old key dies immediately
client.Sessions.Logs.Messages(ctx, 3, 1)

client.Messages.Send(ctx, to, wapi.Text("hi"))
client.Messages.Send(ctx, to, wapi.ImageURL(u), wapi.Text("caption"))
client.Messages.Info(ctx, 100024)
client.Messages.React(ctx, key, "👍")                 // wapi extension
client.Messages.Media.Upload(ctx, bytes, "image/png", "photo.png")

client.Contacts.List(ctx)                             // flat list
client.Contacts.Page(ctx, 1, 50)                      // different shape — see below
client.Contacts.LID.ToPhone(ctx, lid)                 // "" when unknown

client.Groups.Metadata(ctx, jid)
client.Groups.Participants.Add(ctx, jid, []string{"+51..."})
```

Send options are functional rather than a struct, so setting two content fields is visible at the
call site. `wapi.Field(name, value)` covers documented fields the SDK does not model.

## Things that will surprise you

**`List` and `Page` are separate methods.** `?paginated=true` returns a *different shape* —
`{items, pagination}` rather than a bare array. One method with a flag would decode into the
wrong type and yield nothing.

**Nothing unwraps `data` centrally.** Five success envelopes: `Status` returns a bare
`{"status": …}`, uploads put `publicUrl` at the top level, `Delete` returns `204` with no body.

**A timeout on a send is ambiguous.** It means the request failed, not that the message went
undelivered. Check `UnavailableError.Ambiguous()` and reconcile with `Messages.Info` — never
resend blindly.

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
