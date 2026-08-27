"""Typed errors, one per failure envelope the API actually emits.

There are three, and which one arrives tells you *where* the failure happened: a route handler
sets ``error``, middleware sets ``message``, and the throttler emits ``{message, retry_after}``
with no ``success`` key at all. A client that reads only one of those keys loses half the
failures and logs ``None`` — the single most common mistake made against this API.

Every error carries ``status`` and ``body``, so nothing is hidden behind the abstraction: if the
SDK has not modelled something, the raw response is still there.
"""

from __future__ import annotations

from typing import Any


class WapiError(Exception):
    """Base error. ``status`` is ``0`` when the request never reached the server."""

    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.body = body

    @property
    def is_session_not_connected(self) -> bool:
        """A ``409`` rather than a ``5xx`` because nothing is broken.

        The number needs linking or reconnecting. Worth branching on: retrying will not help
        until somebody acts.
        """
        return self.status == 409

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}(status={self.status}, message={self.message!r})"


class WapiAuthError(WapiError):
    """``401``/``403`` — missing, invalid, or the wrong *kind* of credential."""

    @property
    def is_wrong_credential_type(self) -> bool:
        """``403`` means the token was valid but of the wrong kind.

        A session key on an account-level route, or a Personal Access Token on a session-scoped
        one. That is a configuration mistake rather than a bad secret, and the two are worth
        telling apart.
        """
        return self.status == 403


class WapiValidationError(WapiError):
    """``422`` — request validation. ``fields`` maps each rejected field to its messages."""

    def __init__(self, status: int, message: str, body: Any, fields: dict[str, list[str]]) -> None:
        super().__init__(status, message, body)
        self.fields = fields


class WapiRateLimitError(WapiError):
    """``429`` — throttled.

    This body carries no ``success`` key at all, because the throttler short-circuits before the
    response envelope is applied. Reproducing that omission is deliberate.
    """

    def __init__(self, status: int, message: str, body: Any, retry_after: int | None) -> None:
        super().__init__(status, message, body)
        self.retry_after = retry_after


class WapiUnavailableError(WapiError):
    """``5xx``, or a transport failure that never reached the server."""

    @property
    def is_ambiguous(self) -> bool:
        """Whether the request may have been applied despite the failure.

        A timeout on a send is genuinely ambiguous — it says the *request* failed, not that the
        message went undelivered. Retrying blindly sends twice. Reconcile with
        ``messages.info(msg_id)`` instead of assuming.
        """
        return self.status == 0 or self.status == 504


def error_for(status: int, body: Any) -> WapiError:
    """Build the right error for a non-2xx response."""
    envelope = body if isinstance(body, dict) else {}
    # Both keys, always: handlers set `error`, middleware sets `message`.
    message = envelope.get("error") or envelope.get("message") or f"wapi request failed ({status})"

    if status in (401, 403):
        return WapiAuthError(status, message, body)
    if status == 422:
        return WapiValidationError(status, message, body, envelope.get("errors") or {})
    if status == 429:
        return WapiRateLimitError(status, message, body, envelope.get("retry_after"))
    if status == 0 or status >= 500:
        return WapiUnavailableError(status, message, body)
    return WapiError(status, message, body)
