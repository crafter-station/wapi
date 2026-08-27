"""Transport.

Zero runtime dependencies — ``urllib.request`` from the standard library, mirroring the
TypeScript client's use of global ``fetch``. An HTTP client that drags in a dependency tree is a
liability in something meant to be dropped into other people's projects, and ``requests`` or
``httpx`` would buy little here: this is JSON in, JSON out, one header.

Synchronous on purpose. The TypeScript client is async because that is the idiom there; most
Python callers of a WhatsApp API are scripts and workers, and a sync client composes with
``asyncio.to_thread`` more easily than the reverse.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .errors import WapiUnavailableError, error_for

DEFAULT_BASE_URL = "https://api.wapi.crafter.run"
DEFAULT_TIMEOUT = 30.0


class Transport:
    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        headers: dict[str, str] | None = None,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("wapi: api_key is required")
        self.api_key = api_key
        # Trailing slashes would produce `//api/...`, which some proxies redirect and others 404.
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.extra_headers = headers or {}
        # Injectable so a test can substitute a double without patching urllib globally.
        self.opener = opener or urllib.request.build_opener()

    def request(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        body: Any = None,
        timeout: float | None = None,
    ) -> Any:
        """One request.

        Returns the *whole* body rather than unwrapping ``data``, because this API has five
        different success envelopes: ``{success, data}`` for most routes, a bare ``{status}`` for
        ``/api/status``, ``api_key`` at the top level for regenerate-key, ``publicUrl`` at the top
        level for upload and decrypt-media, and ``204`` with no body for delete. A single
        ``unwrap(res["data"])`` helper is wrong for four of those, so unwrapping is the caller's
        decision — see ``data()`` below.
        """
        url = self.base_url + path
        if query:
            pairs = {k: str(v) for k, v in query.items() if v is not None}
            if pairs:
                url = f"{url}?{urllib.parse.urlencode(pairs)}"

        payload = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=payload, method=method)
        for key, value in self.extra_headers.items():
            req.add_header(key, value)
        # Added last so a caller cannot override the credential through `headers`.
        req.add_header("Authorization", f"Bearer {self.api_key}")
        req.add_header("Content-Type", "application/json")

        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as response:
                status = response.status
                text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            # urllib raises on 4xx/5xx, so the failure path reads the body here rather than below.
            status = exc.code
            text = exc.read().decode("utf-8", errors="replace")
            raise error_for(status, _parse(text)) from None
        except Exception as exc:  # timeouts, DNS, refused connections
            raise WapiUnavailableError(0, f"wapi: {exc}", None) from None

        # `204` carries no body; parsing it as JSON raises.
        if status == 204 or not text:
            return None
        return _parse(text)


def _parse(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # A non-JSON body from a proxy or gateway is still a failure worth surfacing intact.
        return text


def data(body: Any) -> Any:
    """Pull ``data`` out of the common envelope.

    Only for the routes that use it. The four that do not are handled explicitly at their call
    sites, which is deliberate: making the exception visible in the resource file beats a clever
    helper that silently returns the wrong thing.
    """
    return body["data"]
