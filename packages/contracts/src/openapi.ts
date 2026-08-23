import { z } from "zod";
import { ROUTES } from "./generated/routes.js";

/**
 * OpenAPI 3.1 document, generated from the same contract the handlers validate against.
 *
 * PLAN.md §1: WasenderAPI's own docs are a hand-edited database CMS — rows of stored HTML —
 * which is exactly why their docs can drift from their API. Ours are emitted from `ROUTES`,
 * so a route that changes shape changes its documentation in the same commit or fails CI.
 *
 * Every description below is written by us. The mirrored spec supplied structure — method,
 * path, field names, types — but its prose is WasenderAPI's copyright and is not reproduced.
 */

const jsonSchema = (schema: unknown) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = z.toJSONSchema(schema as any, { io: "input" }) as Record<string, unknown>;
    delete s["$schema"];
    return s;
  } catch {
    return { type: "object" };
  }
};

/** Our own one-line summaries, keyed by operationId. */
const SUMMARIES: Record<string, string> = {
  getApiWhatsappSessions: "List every WhatsApp session on the account",
  postApiWhatsappSessions: "Create a WhatsApp session and issue its API key",
  getApiWhatsappSessionsWhatsappSession: "Fetch one session, including its API key and webhook secret",
  putApiWhatsappSessionsWhatsappSession: "Update a session's settings, webhook config or proxy",
  deleteApiWhatsappSessionsWhatsappSession: "Delete a session and revoke its API key",
  postApiWhatsappSessionsWhatsappSessionConnect: "Begin linking, returning a QR code when one is ready",
  postApiWhatsappSessionsWhatsappSessionDisconnect: "Close the socket without unlinking the device",
  postApiWhatsappSessionsWhatsappSessionRestart: "Reconnect a live session using its stored credentials",
  postApiWhatsappSessionsWhatsappSessionRegenerateKey: "Issue a new API key, invalidating the old one",
  getApiWhatsappSessionsWhatsappSessionQrcode: "Fetch the current QR string for a session awaiting a scan",
  getApiWhatsappSessionsWhatsappSessionMessageLogs: "Paginated log of messages sent through a session",
  getApiStatus: "Connection state of the session the API key belongs to",
  getApiUser: "WhatsApp identity behind the session key, including its LID",
  postApiSendMessage: "Send a message. One endpoint for every message type",
  postApiUpload: "Upload a file and get a public URL, as raw bytes or base64",
  postApiDecryptMedia: "Decrypt an inbound media node and return a URL valid for one hour",
  getApiMessagesMsgIdInfo: "Fetch a sent message by its integer msgId",
  postApiMessagesRead: "Mark a received message as read",
  getApiContacts: "Contacts known to this session",
  getApiContactsContactPhoneNumber: "Fetch one contact",
  getApiOnWhatsappContactIdentifier: "Check whether a number is registered on WhatsApp",
  getApiLidFromPn: "Resolve a phone number to its LID",
  getApiPnFromLid: "Resolve a LID back to a phone number, where known",
  getApiGroups: "Groups this session belongs to",
  postApiGroups: "Create a group",
  getApiGroupsGroupJidMetadata: "Group subject, description, owner and participants",
  getApiGroupsGroupJidParticipants: "Participants of a group",
  postApiGroupsGroupJidParticipantsAdd: "Add participants to a group",
  postApiGroupsGroupJidParticipantsRemove: "Remove participants from a group",
};

/** Routes whose credential is the account-scoped token rather than a session key. */
const PAT_ONLY = new Set(
  ROUTES.filter((r) => r.path.startsWith("/api/whatsapp-sessions")).map((r) => r.operationId),
);

const tagFor = (path: string): string => {
  if (path.startsWith("/api/whatsapp-sessions") || path === "/api/status" || path === "/api/user")
    return "Sessions";
  if (path.startsWith("/api/groups")) return "Groups";
  if (
    path.startsWith("/api/contacts") ||
    path.startsWith("/api/on-whatsapp") ||
    path.includes("lid")
  )
    return "Contacts";
  return "Messages";
};

export function buildOpenApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const path = route.path;
    paths[path] ??= {};

    const parameters = route.pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    const patOnly = PAT_ONLY.has(route.operationId);

    paths[path]![route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: SUMMARIES[route.operationId] ?? route.operationId,
      description: patOnly
        ? "Requires a **Personal Access Token**. Session API keys are rejected."
        : "Requires a **Session API Key**. The key identifies the session, so no session id is passed.",
      tags: [tagFor(path)],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean" }, data: {} },
              },
            },
          },
        },
        "401": { description: "Missing or invalid credential" },
        "403": { description: "Wrong credential type for this endpoint" },
        "422": { description: "Validation failed" },
        "503": { description: "The WhatsApp service is temporarily unavailable" },
      },
      security: [{ bearerAuth: [] }],
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "wapi",
      version: "0.1.0",
      description: [
        "A WhatsApp REST API, wire-compatible with WasenderAPI.",
        "",
        "**Two credential types.** A *Personal Access Token* is account-scoped and required for",
        "session management. A *Session API Key* is issued per session and used for everything",
        "else — it identifies the session, which is why endpoints like `GET /api/status` take no",
        "session id. Send either as `Authorization: Bearer <token>`.",
        "",
        "**Response envelopes are deliberately inconsistent**, because the interface being cloned",
        "is inconsistent. Most successes are `{success, data}`, but `regenerate-key` returns",
        "`api_key` at the top level, `restart` returns `message`, upload and decrypt-media return",
        "`publicUrl`, and `GET /api/status` returns a bare `{status}` with no envelope. Failures",
        "from route handlers use `error`; failures from middleware use `message`.",
      ].join("\n"),
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "PAT or Session API Key" },
      },
    },
    tags: [
      { name: "Sessions", description: "Create, connect and manage WhatsApp sessions" },
      { name: "Messages", description: "Send, read and inspect messages; upload and decrypt media" },
      { name: "Contacts", description: "Contact lookup and LID resolution" },
      { name: "Groups", description: "Group metadata and participant management" },
    ],
    paths,
  };
}
