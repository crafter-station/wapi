import { z } from "zod";

/**
 * Routes that are ours, not theirs.
 *
 * `generated/routes.ts` is rewritten wholesale by `bun run contracts:generate`, so anything
 * hand-added there is destroyed on the next run. Extensions live here instead, which also keeps
 * the cloned surface countable: `ROUTES` stays exactly the 46 endpoints being reproduced, and
 * anything in this file is visibly an addition.
 *
 * Each entry declares its `scope` — which credential a caller must send — for the same reason the
 * generated routes do: the API derives its authentication middleware from it, and the CLI derives
 * which credential to attach. See `SCOPES` in `generate.ts`.
 *
 * The bar for adding to this file is high. Strict fidelity means their published SDK runs
 * against us unmodified, and an endpoint they never call cannot break that — but each addition
 * is one more thing that is true of wapi and not of the interface it claims to clone. Extending
 * an *existing* documented route is a different and worse proposition, because it changes the
 * behaviour of something a client already knows.
 */

/**
 * Reactions.
 *
 * WasenderAPI emits `messages.reaction` as a webhook — it tells you when somebody reacts — but
 * documents no way to send one. Of the 51 endpoints in the mirrored spec, none does.
 *
 * Addressed by WhatsApp `key` rather than our integer `msgId`, following `POST /api/messages/read`
 * and for the same reason: the useful case is reacting to a message someone *else* sent, and
 * inbound messages have no row in our table. `msgId` only exists for messages we sent.
 */
export const postApiMessagesReactBody = z.object({
  key: z.object({
    id: z.string().min(1),
    remoteJid: z.string().min(1),
    fromMe: z.boolean().optional(),
    participant: z.string().optional(),
  }),
  /**
   * The emoji, or an empty string to remove an existing reaction.
   *
   * Empty is WhatsApp's own convention for clearing rather than a separate call, so it is
   * allowed deliberately — rejecting it as blank would leave no way to undo a reaction.
   */
  emoji: z.string().max(16),
});

/**
 * Sandbox controls.
 *
 * A fake WhatsApp needs a way to be created and driven, and none of it exists upstream — there
 * is nothing to be faithful to. Three endpoints, each earning its place against the bar above:
 *
 *   - **create** is separate rather than a `sandbox: true` flag on `POST /api/whatsapp-sessions`,
 *     because extending a documented route changes behaviour a client already knows. A route
 *     they never call cannot.
 *   - **inbound** is the sandbox's actual payload. What nobody can test today is whether their
 *     webhook handler works, and that needs a real delivery with a real signature.
 *   - **scan** exists because pairing is simulated, not skipped. The fake pairs itself after a
 *     few seconds; this is for anyone testing the waiting state deliberately.
 */
export const postApiSandboxSessionsBody = z.object({
  name: z.string().min(1).max(120),
});

export const postApiSandboxInboundBody = z.object({
  /**
   * Sender JID. Defaults to the session's first derived contact, so the common case needs no
   * argument and the message is still attributable to somebody.
   */
  from: z.string().min(1).optional(),
  text: z.string().min(1).max(4096),
});

export const postApiSandboxScanBody = z.object({});

export const EXTENSION_ROUTES = [
  {
    body: postApiMessagesReactBody,
    method: "POST",
    operationId: "postApiMessagesReact",
    path: "/api/messages/react",
    pathParams: [] as string[],
    scope: "session" as const,
  },
  {
    body: postApiSandboxSessionsBody,
    method: "POST",
    operationId: "postApiSandboxSessions",
    path: "/api/sandbox/sessions",
    pathParams: [] as string[],
    // Account-level, like every other session-creating route: it needs a PAT.
    scope: "pat" as const,
  },
  {
    body: postApiSandboxInboundBody,
    method: "POST",
    operationId: "postApiSandboxInbound",
    path: "/api/sandbox/inbound",
    pathParams: [] as string[],
    scope: "session" as const,
  },
  {
    body: postApiSandboxScanBody,
    method: "POST",
    operationId: "postApiSandboxScan",
    path: "/api/sandbox/scan",
    pathParams: [] as string[],
    scope: "session" as const,
  },
] as const;

export type ExtensionRouteDef = (typeof EXTENSION_ROUTES)[number];
