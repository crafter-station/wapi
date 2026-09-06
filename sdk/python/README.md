# wapi — Python client

Zero runtime dependencies. Python 3.10+.

## Install

Not on PyPI — it lives in the repository, and pip handles git subdirectories:

```bash
pip install "git+https://github.com/crafter-station/wapi.git#subdirectory=sdk/python"
```

Pin a tag for anything you deploy; `main` moves:

```bash
pip install "git+https://github.com/crafter-station/wapi.git@v0.3.0#subdirectory=sdk/python"
```

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
client.send_presence(jid, "composing")           # typing indicator
client.fetch_username(jid)                       # usually {"username": None}

client.sessions.list()                           # PAT
client.sessions.connection.connect(3)
client.sessions.keys.regenerate(3)               # old key dies immediately
client.sessions.logs.messages(3, page=1)         # what was sent
client.sessions.logs.activity(3, page=1)         # what happened to the connection

client.messages.send(to="+51...", text="hi")
client.messages.info(100024)
client.messages.edit(100024, "corrected")        # short window only
client.messages.delete(100024)                   # returns a string, not a dict
client.messages.resend(100024)                   # failed messages only
client.messages.react(key, "👍")                 # wapi extension
client.messages.media.upload(b"...", "image/png")

client.contacts.list()                           # flat list
client.contacts.page(page=1, limit=50)           # different shape — see below
client.contacts.save(jid, "Ada")                 # stored by wapi, not on the phone
client.contacts.block(number) / unblock(number)
client.contacts.picture(number)                  # {"imgUrl": None} is normal
client.contacts.lid.to_phone(lid)                # None on 404

client.groups.metadata(jid)
client.groups.leave(jid)
client.groups.invite_link(jid)                   # returns a string, not a dict
client.groups.by_invite(code) / accept_invite(code)
client.groups.update_settings(jid, subject="New name")
client.groups.participants.add(jid, ["+51..."])
client.groups.participants.update(jid, ["+51..."], "promote")

client.sandbox.create_session("dev")             # wapi extension
```

## Things that will surprise you

**`list()` and `page()` are separate methods.** `?paginated=true` returns a *different shape* —
`{items, pagination}` rather than a bare list. One method with a flag would let you read the
wrong thing and get `None`.

**Nothing unwraps `data` centrally.** There are six success envelopes; `status()` returns a bare
`{"status": ...}`, uploads put `publicUrl` at the top level, `groups.invite_link` puts
`inviteLink` there, `messages.delete` and `.resend` put `message` there, and session delete
returns `204` with no body. A single unwrap helper is wrong for five of them, so each method
handles its own — which is why a few return a plain `str` rather than a dict.

**A timeout on a send is ambiguous.** It means the request failed, not that the message went
undelivered. Retrying blindly sends twice — reconcile with `messages.info(msg_id)`.

**Reactions and the sandbox are wapi extensions.** WasenderAPI reports reactions over webhooks
but has no endpoint to send one, and has nothing like a sandbox session. Feature-detect if you
target both.

**Promote/demote reports differently from add/remove.** `participants.add` and `.remove` return a
per-participant list of `{status, jid, message}`; `participants.update` returns
`{"participants": [jid]}` with no status at all. On the latter, compare what you sent against
what comes back to notice a partial failure. Theirs, not ours.

**`fetch_username` almost always returns `None`.** WhatsApp volunteers a username only for
accounts that have set one and offers no way to ask, so `None` means "not told us" and "has none"
alike. Same for `contacts.picture`: `{"imgUrl": None}` is the ordinary answer, inside a `200`.

**Editing and deleting only work briefly.** WhatsApp allows both for a short window after sending
and gives no way to ask how long is left, so a refusal is expected rather than a bug.

## Errors

`WapiError` is the base; all carry `status` and the raw `body`.

| Class | When |
| --- | --- |
| `WapiAuthError` | 401, 403 — `.is_wrong_credential_type` separates them |
| `WapiValidationError` | 422 — `.fields` maps field to messages |
| `WapiRateLimitError` | 429 — `.retry_after` in seconds |
| `WapiUnavailableError` | 5xx or transport failure — `.is_ambiguous` |

`WapiError.is_session_not_connected` covers the `409` you get before a number is linked.
