"""Account-level session management.

Every route here needs a **Personal Access Token**, not a session key. Using the wrong kind
returns ``403``, not ``401`` — see :attr:`WapiAuthError.is_wrong_credential_type`.
"""

from __future__ import annotations

from typing import Any

from .._http import Transport, data


class SessionConnection:
    """What you can do to a live socket."""

    def __init__(self, http: Transport) -> None:
        self._http = http

    def connect(self, session_id: int) -> Any:
        """Begin linking, or reconnect from stored credentials.

        Returns immediately with a status and possibly a ``qrCode``; it does not wait for the
        scan. Note the status is SCREAMING_CASE here and lowercase everywhere else — an
        inconsistency inherited from the API being reproduced.

        Poll :meth:`WapiClient.status` until it reads ``connected``; the QR rotates while you
        wait.
        """
        return data(self._http.request("POST", f"/api/whatsapp-sessions/{session_id}/connect"))

    def disconnect(self, session_id: int) -> Any:
        """Close the socket without unlinking the device."""
        return data(self._http.request("POST", f"/api/whatsapp-sessions/{session_id}/disconnect"))

    def restart(self, session_id: int) -> str:
        """Reconnect a live session using its stored credentials.

        ``message`` at the top level — one of the five success envelopes, which is why nothing is
        unwrapped centrally.
        """
        return self._http.request("POST", f"/api/whatsapp-sessions/{session_id}/restart")["message"]

    def qr_code(self, session_id: int) -> Any:
        """The current QR string for a session awaiting a scan."""
        return data(self._http.request("GET", f"/api/whatsapp-sessions/{session_id}/qrcode"))


class SessionKeys:
    def __init__(self, http: Transport) -> None:
        self._http = http

    def regenerate(self, session_id: int) -> str:
        """Issue a new API key, invalidating the old one **immediately**.

        Anything still using the previous key starts getting ``401`` the moment this returns —
        deployed apps, scripts, webhook consumers. There is no grace period.

        ``api_key`` arrives at the top level rather than under ``data``.
        """
        return self._http.request(
            "POST", f"/api/whatsapp-sessions/{session_id}/regenerate-key"
        )["api_key"]


class SessionLogs:
    def __init__(self, http: Transport) -> None:
        self._http = http

    def messages(self, session_id: int, page: int = 1) -> Any:
        """Paginated log of messages sent through a session.

        Uses Laravel's length-aware paginator — ``current_page``, ``per_page``, ``total`` — which
        is a *different* shape from the ``?paginated=true`` mode on contacts and groups. Two
        unrelated pagination styles in one API is not a design anyone chose; it is what is being
        reproduced.
        """
        return data(
            self._http.request(
                "GET",
                f"/api/whatsapp-sessions/{session_id}/message-logs",
                query={"page": page},
            )
        )


class SessionsResource:
    def __init__(self, http: Transport) -> None:
        self._http = http
        self.connection = SessionConnection(http)
        self.keys = SessionKeys(http)
        self.logs = SessionLogs(http)

    def list(self) -> list[Any]:
        """Every session on the account. Credentials are **not** included here."""
        return data(self._http.request("GET", "/api/whatsapp-sessions"))

    def get(self, session_id: int) -> Any:
        """One session, including its ``api_key`` and ``webhook_secret`` in plaintext.

        That is the documented behaviour of the API being reproduced, which is why the key cannot
        be stored hash-only server-side. Treat this response as a secret.
        """
        return data(self._http.request("GET", f"/api/whatsapp-sessions/{session_id}"))

    def create(self, **fields: Any) -> Any:
        """Create a session and issue its API key.

        Requires ``name`` and ``phone_number``. The response is the only place the key and
        webhook secret appear on creation.
        """
        return data(self._http.request("POST", "/api/whatsapp-sessions", body=fields))

    def update(self, session_id: int, **fields: Any) -> Any:
        """Update settings, webhook configuration or proxy.

        ``proxy_url`` must be a public hostname: IP addresses and private ranges are rejected,
        because the value becomes an outbound proxy for the server's own egress.
        """
        return data(
            self._http.request("PUT", f"/api/whatsapp-sessions/{session_id}", body=fields)
        )

    def delete(self, session_id: int) -> None:
        """Delete a session and revoke its API key.

        Both at once: the key is the session, so deleting one destroys the other. Returns ``204``
        with no body, which is why this returns ``None`` rather than a parsed envelope.
        """
        self._http.request("DELETE", f"/api/whatsapp-sessions/{session_id}")
