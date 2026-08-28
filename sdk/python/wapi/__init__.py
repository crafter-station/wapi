"""wapi — a client for the wapi WhatsApp REST API.

    from wapi import WapiClient

    client = WapiClient(api_key="...")
    client.messages.send(to="+51999888777", text="hello")

Types are generated from the OpenAPI document; the method surface is written by hand. Generated
names would read ``post_api_whatsapp_sessions_whatsapp_session_regenerate_key``, because the
``operationId``s are mechanical path transliterations — see ``sdk/README.md`` for the reasoning
and ``ops/check-sdk-in-sync.mjs`` for what keeps the two halves honest.
"""

from __future__ import annotations

from typing import Any

from ._http import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, Transport, data
from .errors import (
    WapiAuthError,
    WapiError,
    WapiRateLimitError,
    WapiUnavailableError,
    WapiValidationError,
)
from .resources.directory import ContactsResource, GroupsResource
from .resources.messages import MessagesResource
from .resources.sandbox import SandboxResource
from .resources.sessions import SessionsResource

__all__ = [
    "WapiClient",
    "WapiError",
    "WapiAuthError",
    "WapiValidationError",
    "WapiRateLimitError",
    "WapiUnavailableError",
]


class WapiClient:
    """The client.

    ``api_key`` is either a **session API key** or a **Personal Access Token**, and they are not
    interchangeable: messaging, contacts and groups take the session key, while creating or
    deleting sessions takes a PAT. Using the wrong one returns ``403``, not ``401``.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._http = Transport(api_key, base_url=base_url, timeout=timeout, headers=headers)
        self.sessions = SessionsResource(self._http)
        self.messages = MessagesResource(self._http)
        self.contacts = ContactsResource(self._http)
        self.groups = GroupsResource(self._http)
        # wapi extension: a fake number on a fake WhatsApp. See SandboxResource.
        self.sandbox = SandboxResource(self._http)

    def send_presence(self, jid: str, type: str) -> Any:
        """Tell a chat you are typing, recording, or online.

        One of ``unavailable``, ``available``, ``composing``, ``recording``, ``paused``.
        Fire-and-forget by nature: WhatsApp acknowledges nothing, so returning means the frame
        left, not that anybody saw it.
        """
        return self._http.request(
            "POST", "/api/send-presence-update", body={"jid": jid, "type": type}
        )["data"]

    def fetch_username(self, identifier: str) -> Any:
        """A contact's WhatsApp @username, when there is one.

        ``None`` far more often than not: WhatsApp volunteers a username only for accounts that
        have set one, and offers no way to ask.
        """
        from urllib.parse import quote

        return self._http.request("GET", f"/api/fetch-username/{quote(identifier)}")["data"]

    def status(self) -> str:
        """Connection state of the session this key belongs to.

        A bare ``{"status": ...}`` with **no ``success`` wrapper** — one of five success
        envelopes, and the reason this client does not unwrap ``data`` centrally.
        """
        return self._http.request("GET", "/api/status")["status"]

    def user(self) -> Any:
        """The WhatsApp identity behind the session key, including its LID."""
        return data(self._http.request("GET", "/api/user"))
