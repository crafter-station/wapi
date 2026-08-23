/**
 * Recipient normalisation.
 *
 * Their `to` field accepts five different things (PLAN.md §1): an E.164 phone number, a bare
 * number, a WhatsApp JID, a group JID (`@g.us`), a channel JID (`@newsletter`), or a username
 * handle (`@jane_doe`). Baileys wants a JID, and passing it a bare number fails deep inside
 * `jidDecode` with "Cannot destructure property 'user' of undefined" — an error that says
 * nothing useful about the actual problem.
 */

/** Domains Baileys understands. `@lid` and `@hosted*` arrived with v7 (PLAN.md §4). */
const JID_DOMAINS = [
  "@s.whatsapp.net",
  "@g.us",
  "@newsletter",
  "@broadcast",
  "@lid",
  "@hosted",
  "@hosted.lid",
];

export type RecipientKind = "user" | "group" | "channel" | "broadcast" | "username";

export type ResolvedRecipient =
  | { ok: true; jid: string; kind: RecipientKind }
  | { ok: false; reason: string };

export function resolveRecipient(raw: string): ResolvedRecipient {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "The to field is required." };

  // Already a JID: keep the domain, strip any device suffix from the user part. The device
  // part is not stable across reconnects, so it must never be treated as identity.
  const domain = JID_DOMAINS.find((d) => input.toLowerCase().endsWith(d));
  if (domain) {
    const user = input.slice(0, input.length - domain.length).split(":")[0] ?? "";
    if (!user) return { ok: false, reason: "The to field is not a valid WhatsApp identifier." };
    return {
      ok: true,
      jid: `${user}${domain}`,
      kind:
        domain === "@g.us"
          ? "group"
          : domain === "@newsletter"
            ? "channel"
            : domain === "@broadcast"
              ? "broadcast"
              : "user",
    };
  }

  /**
   * Username handle, e.g. `@jane_doe`.
   *
   * Not resolvable without a USync lookup, and v7's `onWhatsApp()` no longer returns LIDs,
   * so this needs the `lid_map` table that Tier 1's LID routes are built on. Rejected
   * explicitly rather than mangled into a phone JID, which would silently message a stranger.
   */
  if (input.startsWith("@")) {
    return { ok: false, reason: "Username handles are not supported yet; use a phone number or JID." };
  }

  const digits = input.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return { ok: false, reason: "The to field must be a valid phone number in E.164 format." };
  }
  return { ok: true, jid: `${digits}@s.whatsapp.net`, kind: "user" };
}
