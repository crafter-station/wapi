"""Sending, reading and media. Session API key."""

from __future__ import annotations

import base64 as _base64
from typing import Any

from .._http import Transport, data


class Media:
    def __init__(self, http: Transport) -> None:
        self._http = http

    def upload(self, content: bytes, mimetype: str, file_name: str | None = None) -> str:
        """Upload bytes and get a **permanent** URL to pass to :meth:`MessagesResource.send`.

        Permanent is the point: media is fetched server-side at send time, so an expiring link
        would stop working between upload and delivery.

        ``publicUrl`` sits at the top level, not under ``data``. Caps at 16 MB.
        """
        body = {
            "base64": _base64.b64encode(content).decode("ascii"),
            "mimetype": mimetype,
        }
        if file_name:
            body["fileName"] = file_name
        # Uploads are slower than reads; the default deadline is too tight for a large file.
        return self._http.request("POST", "/api/upload", body=body, timeout=120.0)["publicUrl"]

    def decrypt(self, message: dict[str, Any]) -> str:
        """Turn an inbound encrypted media node into a URL valid for one hour.

        Inbound media arrives as a CDN link plus a ``mediaKey``; the bytes are useless without
        decryption, and only the session holding the keys can do it. Pass the ``message`` object
        straight from the webhook payload.
        """
        return self._http.request(
            "POST", "/api/decrypt-media", body={"data": {"messages": {"message": message}}}
        )["publicUrl"]


class MessagesResource:
    def __init__(self, http: Transport) -> None:
        self._http = http
        self.media = Media(http)

    def send(self, to: str, **content: Any) -> Any:
        """Send a message. One endpoint for every type.

        Which field you set decides what is sent — ``text``, ``imageUrl``, ``documentUrl``,
        ``location``, ``poll`` and so on. Setting two content fields is an error rather than a
        silent preference. ``to`` may be a phone number, a JID, or a group JID ending ``@g.us``.

        **A timeout here is ambiguous.** It says the request failed, not that the message went
        undelivered — retrying blindly sends twice. Reconcile with :meth:`info` instead.
        """
        return data(self._http.request("POST", "/api/send-message", body={"to": to, **content}))

    def info(self, msg_id: int) -> Any:
        """Fetch a sent message by its integer ``msgId``.

        Two fields do not match what :meth:`send` returns, because this route returns WhatsApp's
        own record: ``messageTimestamp`` is a **string** (a protobuf int64) and ``status`` is a
        **number** — 0 error, 1 pending, 2 sent, 3 delivered, 4 read.
        """
        return data(self._http.request("GET", f"/api/messages/{msg_id}/info"))

    def edit(self, msg_id: int, text: str) -> Any:
        """Edit a message you sent.

        WhatsApp allows this only for a short window afterwards and gives no way to ask how long
        is left, so a refusal is an ordinary outcome. The edit is a *new* message superseding the
        old one, so the response carries a fresh key alongside the original ``msgId``.
        """
        return data(self._http.request("PUT", f"/api/messages/{msg_id}", body={"text": text}))

    def delete(self, msg_id: int) -> str:
        """Delete a message for everyone. Same short window as editing.

        This endpoint puts ``message`` at the *top level* rather than under ``data``, so it
        returns the confirmation string rather than unwrapping.
        """
        return str(self._http.request("DELETE", f"/api/messages/{msg_id}")["message"])

    def resend(self, msg_id: int) -> str:
        """Retry a message whose status is ``failed``.

        Only failed messages, deliberately: a send that timed out is recorded as ``in_progress``
        because nobody knows whether it arrived, and resending one of those is how a customer
        gets the same message twice.
        """
        return str(self._http.request("POST", f"/api/messages/{msg_id}/resend")["message"])

    def mark_read(self, key: dict[str, Any]) -> Any:
        """Mark a *received* message as read.

        Takes the WhatsApp ``key`` rather than a ``msgId``: inbound messages have no ``msgId``,
        which only ever identifies something you sent. Take the key from the webhook payload.
        """
        return data(self._http.request("POST", "/api/messages/read", body={"key": key}))

    def react(self, key: dict[str, Any], emoji: str) -> Any:
        """React to a message.

        **A wapi extension**, not part of the WasenderAPI interface — they report reactions over
        webhooks but offer no way to send one. Feature-detect if you target both.

        Keyed like :meth:`mark_read`, and for the same reason.
        """
        return data(
            self._http.request("POST", "/api/messages/react", body={"key": key, "emoji": emoji})
        )

    def unreact(self, key: dict[str, Any]) -> Any:
        """Remove a reaction. An empty emoji is WhatsApp's convention, not a separate endpoint."""
        return self.react(key, "")
