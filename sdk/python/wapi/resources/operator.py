"""Operator resources — tokens, audit, dispatches, and reading a sandbox conversation.

These are wapi extensions; WasenderAPI has no equivalent. They exist so a client can manage its
own credentials and see what the server did, without needing database access.
"""

from __future__ import annotations

from typing import Any

from .._http import Transport, data


class TokensResource:
    """Personal Access Tokens — the account-level credential. PAT-scoped."""

    def __init__(self, http: Transport) -> None:
        self._http = http

    def create(self, name: str) -> Any:
        """Mint a token.

        **The plaintext is returned exactly once** — only the hash is stored, so there is no call
        that can show it again and ``list`` deliberately cannot.
        """
        return data(self._http.request("POST", "/api/tokens", body={"name": name}))

    def list(self) -> list[Any]:
        """Every token on the account, including revoked ones. Never the secret."""
        return data(self._http.request("GET", "/api/tokens"))

    def revoke(self, token_id: int) -> str:
        """Revoke a token.

        Revoking the one you are holding works, and is how a machine logs itself out: the call
        authenticates first, and the credential stops working immediately afterwards. The row is
        marked revoked rather than deleted so the audit trail keeps pointing at something.

        Returns a confirmation string — ``message`` sits at the top level, not under ``data``.
        """
        return str(self._http.request("DELETE", f"/api/tokens/{token_id}")["message"])


class AuditResource:
    """The record of every call made with this account's credentials. PAT-scoped."""

    def __init__(self, http: Transport) -> None:
        self._http = http

    def page(self, page: int = 1, per_page: int = 15, session_id: int | None = None) -> Any:
        """One page of calls, newest first.

        Account-scoped rather than session-scoped: calls made with a PAT — creating a session,
        rotating a key — have no session at all, so filing them under one would hide exactly the
        actions most worth auditing. ``session_id`` narrows to one when that is what you want.
        """
        query: dict[str, Any] = {"page": page, "per_page": per_page}
        if session_id is not None:
            query["session_id"] = session_id
        return data(self._http.request("GET", "/api/audit-logs", query=query))

    def get(self, audit_log_id: int) -> Any:
        """One call, with the request and response bodies the list omits.

        Bodies are present only if body capture was enabled when the call happened, and the
        retention sweep nulls them after a week — so absent is normal rather than an error.
        """
        return data(self._http.request("GET", f"/api/audit-logs/{audit_log_id}"))


class DispatchesResource:
    """What the webhook worker actually sent, for this session. Session-scoped."""

    def __init__(self, http: Transport) -> None:
        self._http = http

    def page(self, page: int = 1, per_page: int = 15) -> Any:
        """One page of delivery attempts, most recent first.

        One row per event, **updated in place** across retries — so ``attempts`` climbing to five
        is the same row changing, not five rows appearing.
        """
        return data(
            self._http.request("GET", "/api/dispatches", query={"page": page, "per_page": per_page})
        )


class SandboxThread:
    """Reading a sandbox's fake conversation. See ``SandboxResource`` for driving one."""

    def __init__(self, http: Transport) -> None:
        self._http = http

    def list(self) -> list[Any]:
        """The conversation so far, oldest first — both directions.

        Held in the gateway's memory and bounded at 200 entries, so there is no pagination and a
        gateway restart returns the sandbox to its fixtures.
        """
        return data(self._http.request("GET", "/api/sandbox/thread"))
