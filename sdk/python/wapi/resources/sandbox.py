"""The sandbox — a fake number on a fake WhatsApp.

**A wapi extension**, not part of the WasenderAPI interface. It exists because linking a real
number is the highest-friction step in this product and the one that carries a ban risk, so you
should not have to do it to find out whether your integration works.

A sandbox session goes through the same routes and the same code as a real one: it pairs itself
after a few seconds, has a small deterministic directory, accepts sends and can be made to
receive them. Its number lives under ITU country code 999, which is unassigned and cannot route.

Two differences from production, deliberate and worth knowing before tuning anything against
them: ``account_protection`` pacing is ignored, so sends return immediately where production
would wait five seconds; and ``decrypt-media`` returns a fixed PNG rather than real media.
"""

from __future__ import annotations

from typing import Any

from .._http import Transport, data


class SandboxResource:
    def __init__(self, http: Transport) -> None:
        self._http = http

    def create_session(self, name: str) -> Any:
        """Create a sandbox session. Requires a **Personal Access Token**.

        The number is not yours to choose — it is derived from the session id, so it cannot
        collide with a real one. The response carries the session's own API key, which is what
        every other call here uses.
        """
        return data(self._http.request("POST", "/api/sandbox/sessions", body={"name": name}))

    def inbound(self, text: str, from_: str | None = None) -> Any:
        """Fabricate an inbound message, as if somebody had written to this number.

        The reason the sandbox exists. It travels the ordinary pipeline, so the webhook reaching
        your handler is signed exactly as a real one. Use a **session key** here, not a PAT.

        ``from_`` defaults to the session's first derived contact. The trailing underscore avoids
        shadowing the ``from`` keyword; the wire field is ``from``.
        """
        body: dict[str, Any] = {"text": text}
        if from_ is not None:
            body["from"] = from_
        return data(self._http.request("POST", "/api/sandbox/inbound", body=body))

    def scan(self) -> Any:
        """Finish pairing immediately rather than waiting for the fake QR to resolve itself.

        Only useful when deliberately testing the waiting state — a sandbox session connects on
        its own a few seconds after ``sessions.connection.connect``.
        """
        return data(self._http.request("POST", "/api/sandbox/scan", body={}))
