import { z } from "zod";

/**
 * Routes that are ours, not theirs.
 *
 * `generated/routes.ts` is rewritten wholesale by `bun run contracts:generate`, so anything
 * hand-added there is destroyed on the next run. Extensions live here instead, which also keeps
 * the cloned surface countable: `ROUTES` stays exactly the 29 endpoints being reproduced, and
 * anything in this file is visibly an addition.
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

export const EXTENSION_ROUTES = [
  {
    body: postApiMessagesReactBody,
    method: "POST",
    operationId: "postApiMessagesReact",
    path: "/api/messages/react",
    pathParams: [] as string[],
  },
] as const;

export type ExtensionRouteDef = (typeof EXTENSION_ROUTES)[number];
