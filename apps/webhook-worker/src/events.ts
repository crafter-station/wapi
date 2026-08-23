/**
 * Mapping engine events onto the documented public webhook names.
 *
 * PLAN.md §1: we ship 22 of their 23 events (all but `passkey.updated`). The expensive part
 * of this feature is the pipeline — queue, retry, signature, per-session filtering — so
 * cutting events would save nothing. Three of them are literally filtered views of one
 * Baileys event, which is why they cost a `where` clause each.
 */

export type PublicEvent = { event: string; data: unknown };

/** JID suffix tests, used for the group/personal/newsletter fan-out. */
const isGroup = (jid: string | undefined) => Boolean(jid?.endsWith("@g.us"));
const isNewsletter = (jid: string | undefined) => Boolean(jid?.endsWith("@newsletter"));
const isBroadcast = (jid: string | undefined) => Boolean(jid?.endsWith("@broadcast"));

type WaMessage = { key?: { remoteJid?: string; fromMe?: boolean }; [k: string]: unknown };

/**
 * One Baileys event can produce several public events.
 *
 * `messages.upsert` is the clearest case: it fans out into `messages.upsert` (everything),
 * `messages.received` (inbound only), `message.sent` (outbound only), and the three
 * chat-kind-filtered variants. Their docs describe these as separate webhooks, and an
 * integrator subscribing only to `messages-personal.received` must not receive group traffic.
 */
export function toPublicEvents(baileysEvent: string, payload: unknown): PublicEvent[] {
  const out: PublicEvent[] = [];

  if (baileysEvent === "messages.upsert") {
    const p = payload as { messages?: WaMessage[]; type?: string };
    const messages = p?.messages ?? [];
    out.push({ event: "messages.upsert", data: payload });

    for (const m of messages) {
      const jid = m.key?.remoteJid;
      const fromMe = m.key?.fromMe === true;

      if (fromMe) {
        out.push({ event: "message.sent", data: m });
        continue;
      }

      out.push({ event: "messages.received", data: m });

      if (isGroup(jid)) out.push({ event: "messages-group.received", data: m });
      else if (isNewsletter(jid)) out.push({ event: "messages-newsletter.received", data: m });
      else if (!isBroadcast(jid)) out.push({ event: "messages-personal.received", data: m });
    }
    return out;
  }

  // The rest map one-to-one: their public webhook names are Baileys' event names verbatim,
  // which is itself the strongest evidence the original is Baileys (see TECH-STACK.md).
  const DIRECT: Record<string, string> = {
    "messages.update": "messages.update",
    "messages.delete": "messages.delete",
    "messages.reaction": "messages.reaction",
    "message-receipt.update": "message-receipt.update",
    "chats.upsert": "chats.upsert",
    "chats.update": "chats.update",
    "chats.delete": "chats.delete",
    "contacts.upsert": "contacts.upsert",
    "contacts.update": "contacts.update",
    "groups.upsert": "groups.upsert",
    "groups.update": "groups.update",
    "group-participants.update": "group-participants.update",
    call: "call",
  };

  const mapped = DIRECT[baileysEvent];
  if (mapped) out.push({ event: mapped, data: payload });
  return out;
}

/** Session-level filters from their create-session options. */
export function passesSessionFilters(
  event: PublicEvent,
  opts: { ignoreGroups: boolean; ignoreChannels: boolean; ignoreBroadcasts: boolean },
): boolean {
  const data = event.data as WaMessage | undefined;
  const jid = data?.key?.remoteJid;
  if (opts.ignoreGroups && (isGroup(jid) || event.event.startsWith("group"))) return false;
  if (opts.ignoreChannels && isNewsletter(jid)) return false;
  if (opts.ignoreBroadcasts && isBroadcast(jid)) return false;
  return true;
}
