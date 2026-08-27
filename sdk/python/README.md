# wapi — Python client

Zero runtime dependencies. Python 3.10+.

```python
from wapi import WapiClient

client = WapiClient(api_key="...")           # session key or PAT — see below
client.messages.send(to="+51999888777", text="hello")
```

## Two credentials, not interchangeable

| Token | Use for |
| --- | --- |
| **Session API key** | messaging, contacts, groups, media, status |
| **Personal Access Token** | creating, updating and deleting sessions; rotating keys |

Using the wrong one returns **`403`, not `401`** — the token was valid but of the wrong kind.
That is a configuration mistake rather than a bad secret, so it has its own flag:

```python
except WapiAuthError as e:
    if e.is_wrong_credential_type:  # 403
        ...
```

## The surface

```python
client.status()                                  # bare {"status": ...}, no envelope
client.user()

client.sessions.list()                           # PAT
client.sessions.connection.connect(3)
client.sessions.keys.regenerate(3)               # old key dies immediately
client.sessions.logs.messages(3, page=1)

client.messages.send(to="+51...", text="hi")
client.messages.info(100024)
client.messages.react(key, "👍")                 # wapi extension
client.messages.media.upload(b"...", "image/png")

client.contacts.list()                           # flat list
client.contacts.page(page=1, limit=50)           # different shape — see below
client.contacts.lid.to_phone(lid)                # None on 404

client.groups.metadata(jid)
client.groups.participants.add(jid, ["+51..."])
```

## Things that will surprise you

**`list()` and `page()` are separate methods.** `?paginated=true` returns a *different shape* —
`{items, pagination}` rather than a bare list. One method with a flag would let you read the
wrong thing and get `None`.

**Nothing unwraps `data` centrally.** There are five success envelopes; `status()` returns a bare
`{"status": ...}`, uploads put `publicUrl` at the top level, delete returns `204` with no body.
A single unwrap helper is wrong for four of them, so each method handles its own.

**A timeout on a send is ambiguous.** It means the request failed, not that the message went
undelivered. Retrying blindly sends twice — reconcile with `messages.info(msg_id)`.

**Reactions are a wapi extension.** WasenderAPI reports them over webhooks but has no endpoint to
send one. Feature-detect if you target both.

## Errors

`WapiError` is the base; all carry `status` and the raw `body`.

| Class | When |
| --- | --- |
| `WapiAuthError` | 401, 403 — `.is_wrong_credential_type` separates them |
| `WapiValidationError` | 422 — `.fields` maps field to messages |
| `WapiRateLimitError` | 429 — `.retry_after` in seconds |
| `WapiUnavailableError` | 5xx or transport failure — `.is_ambiguous` |

`WapiError.is_session_not_connected` covers the `409` you get before a number is linked.
