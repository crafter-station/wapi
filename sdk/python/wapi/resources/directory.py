"""Contacts, groups and identity resolution. Session API key."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .._http import Transport, data
from ..errors import WapiError


class LidResolver:
    """WhatsApp increasingly addresses users by LID rather than phone number.

    The two are **not derivable from one another**. Never guess a phone number from a LID.
    """

    def __init__(self, http: Transport) -> None:
        self._http = http

    def from_phone(self, phone_number: str) -> str:
        """Resolve a phone number to its LID."""
        return data(self._http.request("GET", f"/api/lid-from-pn/{quote(phone_number)}"))["lid"]

    def to_phone(self, lid: str) -> str | None:
        """Resolve a LID back to a phone number, where known.

        Returns ``None`` on a ``404``, which is a normal outcome rather than an error: not every
        LID has a known mapping, and there is nothing to retry.
        """
        try:
            return data(self._http.request("GET", f"/api/pn-from-lid/{quote(lid)}"))["pn"]
        except WapiError as exc:
            if exc.status == 404:
                return None
            raise


class ContactsResource:
    def __init__(self, http: Transport) -> None:
        self._http = http
        self.lid = LidResolver(http)

    def list(self) -> list[Any]:
        """Every known contact, as a flat list."""
        return data(self._http.request("GET", "/api/contacts"))

    def page(self, page: int = 1, limit: int = 20) -> Any:
        """One page of contacts.

        A **separate method** rather than a flag on :meth:`list`, because ``?paginated=true``
        returns a different shape — ``{items, pagination}`` instead of a bare list. Merging them
        would let a caller read ``data`` and get ``None``.

        ``limit`` defaults to 20 and caps at 500.
        """
        return data(
            self._http.request(
                "GET", "/api/contacts", query={"paginated": "true", "page": page, "limit": limit}
            )
        )

    def get(self, phone_number: str) -> Any:
        """One contact.

        ``imgUrl`` and ``status`` are always ``None`` in a *list*; this route is where they can
        be populated, because fetching them is a per-contact round-trip to WhatsApp.
        """
        return data(self._http.request("GET", f"/api/contacts/{quote(phone_number)}"))

    def on_whatsapp(self, identifier: str) -> Any:
        """Check whether a number is registered on WhatsApp."""
        return data(self._http.request("GET", f"/api/on-whatsapp/{quote(identifier)}"))

    def save(self, jid: str, full_name: str | None = None) -> Any:
        """Save a contact's name to this session's address book.

        wapi stores this itself — WhatsApp exposes no address-book write — so the name is
        visible to ``list`` and ``get`` but never reaches the linked phone.
        """
        body: dict[str, Any] = {"jid": jid}
        if full_name is not None:
            body["fullName"] = full_name
        return data(self._http.request("PUT", "/api/contacts", body=body))

    def block(self, phone_number: str) -> Any:
        """Block a contact."""
        return data(self._http.request("POST", f"/api/contacts/{quote(phone_number)}/block"))

    def unblock(self, phone_number: str) -> Any:
        """Unblock a contact."""
        return data(self._http.request("POST", f"/api/contacts/{quote(phone_number)}/unblock"))

    def picture(self, phone_number: str) -> Any:
        """A contact's profile picture.

        ``imgUrl`` is ``None`` more often than not — most accounts have no picture, or show it
        only to their own contacts. That is a success with nothing in it, not an error.
        """
        return data(self._http.request("GET", f"/api/contacts/{quote(phone_number)}/picture"))


class GroupParticipants:
    def __init__(self, http: Transport) -> None:
        self._http = http

    def update(self, group_jid: str, participants: list[str], action: str) -> Any:
        """Promote participants to admin, or demote them back.

        ``action`` is ``"promote"`` or ``"demote"``. Same per-JID result shape as ``add``: the
        request can succeed while an individual participant does not, so read each entry's
        ``status`` rather than the HTTP code alone.
        """
        return data(
            self._http.request(
                "PUT",
                f"/api/groups/{quote(group_jid)}/participants/update",
                body={"action": action, "participants": participants},
            )
        )

    def list(self, group_jid: str) -> list[Any]:
        """Participants of a group."""
        return data(self._http.request("GET", f"/api/groups/{quote(group_jid)}/participants"))

    def add(self, group_jid: str, participants: list[str]) -> Any:
        """Add participants.

        Acts on real people in a real chat and is **not undoable** — everyone in the group sees
        it. Worth a confirmation step in anything user-facing.
        """
        return data(
            self._http.request(
                "POST",
                f"/api/groups/{quote(group_jid)}/participants/add",
                body={"participants": participants},
            )
        )

    def remove(self, group_jid: str, participants: list[str]) -> Any:
        """Remove participants. Same caveat as :meth:`add`, more so."""
        return data(
            self._http.request(
                "POST",
                f"/api/groups/{quote(group_jid)}/participants/remove",
                body={"participants": participants},
            )
        )


class GroupsResource:
    def __init__(self, http: Transport) -> None:
        self._http = http
        self.participants = GroupParticipants(http)

    def leave(self, group_jid: str) -> Any:
        """Leave a group. Rejoining needs a fresh invite, so there is no undo."""
        return data(self._http.request("POST", f"/api/groups/{quote(group_jid)}/leave"))

    def invite_link(self, group_jid: str) -> str:
        """The group's invite link.

        This endpoint puts ``inviteLink`` at the *top level* rather than under ``data``, so
        unlike every other method here it does not unwrap.
        """
        res = self._http.request("GET", f"/api/groups/{quote(group_jid)}/invite-link")
        return str(res["inviteLink"])

    def picture(self, group_jid: str) -> Any:
        """A group's picture. ``imgUrl`` is ``None`` when there is none — a success, not an error."""
        return data(self._http.request("GET", f"/api/groups/{quote(group_jid)}/picture"))

    def update_settings(self, group_jid: str, **settings: Any) -> Any:
        """Change a group's settings. Only the fields you pass are touched.

        WhatsApp applies these as separate operations with no transaction, so a partial failure
        can leave earlier fields changed. Requires admin rights in the group.
        """
        return data(
            self._http.request("PUT", f"/api/groups/{quote(group_jid)}/settings", body=settings)
        )

    def by_invite(self, invite_code: str) -> Any:
        """Inspect a group from an invite code without joining it."""
        return data(self._http.request("GET", f"/api/groups/invite/{quote(invite_code)}"))

    def accept_invite(self, code: str) -> Any:
        """Join a group by invite code. Returns the group's JID."""
        return data(self._http.request("POST", "/api/groups/invite/accept", body={"code": code}))

    def list(self) -> list[Any]:
        """Every group this session belongs to."""
        return data(self._http.request("GET", "/api/groups"))

    def page(self, page: int = 1, limit: int = 20) -> Any:
        """One page of groups. Separate from :meth:`list` for the same reason as contacts."""
        return data(
            self._http.request(
                "GET", "/api/groups", query={"paginated": "true", "page": page, "limit": limit}
            )
        )

    def metadata(self, group_jid: str) -> Any:
        """Subject, description, owner and participants."""
        return data(self._http.request("GET", f"/api/groups/{quote(group_jid)}/metadata"))

    def create(self, subject: str, participants: list[str]) -> Any:
        """Create a group."""
        return data(
            self._http.request(
                "POST", "/api/groups", body={"name": subject, "participants": participants}
            )
        )
