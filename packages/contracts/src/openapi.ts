import { z } from "zod";
import { EXTENSION_ROUTES } from "./extensions.js";
import { ROUTES } from "./generated/routes.js";
import {
  failureBody,
  frameworkFailureBody,
  SUCCESS_RESPONSES,
  throttleBody,
} from "./responses.js";

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
  postApiMessagesReact: "React to a message, or clear a reaction with an empty emoji",
  postApiSandboxSessions: "Create a sandbox session — a fake number on a fake WhatsApp",
  postApiSandboxInbound: "Fabricate an inbound message on a sandbox session",
  postApiSandboxScan: "Complete pairing on a sandbox session awaiting its fake QR",
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

/** `{"$ref": "#/components/schemas/X"}`, so the failure envelopes are named once. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const jsonBody = (schema: unknown) => ({
  content: { "application/json": { schema } },
});

/**
 * The response block for one operation.
 *
 * Success comes from `SUCCESS_RESPONSES`, which is exhaustive over `ROUTES` and asserted so by
 * `responses.test.ts` — a new route without a response schema fails that test rather than
 * quietly publishing an empty one.
 *
 * The failure codes are the same four everywhere, but *which envelope* they carry is not
 * uniform, and that is the interface rather than an oversight. 401 and 403 come from middleware
 * and so use the framework shape (`message`); 422 is a validation failure and carries `errors`;
 * 429 has no `success` key at all; 503 is decided by a handler and so uses the controller shape
 * (`error`).
 */
const responsesFor = (operationId: string): Record<string, unknown> => {
  const success = SUCCESS_RESPONSES[operationId];
  const responses: Record<string, unknown> = {};

  if (success === undefined) {
    responses["200"] = { description: "Success" };
  } else if (success.schema === undefined) {
    responses[String(success.status)] = { description: "Deleted. No content." };
  } else {
    responses[String(success.status)] = {
      description: "Success",
      ...jsonBody(jsonSchema(success.schema)),
    };
  }

  responses["401"] = {
    description: "Missing or invalid credential",
    ...jsonBody(ref("FrameworkFailure")),
  };
  responses["403"] = {
    description: "Wrong credential type for this endpoint",
    ...jsonBody(ref("FrameworkFailure")),
  };
  responses["422"] = {
    description: "Validation failed",
    ...jsonBody(ref("ValidationFailure")),
  };
  responses["429"] = {
    description: "Rate limited. Note this body has no `success` key.",
    ...jsonBody(ref("ThrottleFailure")),
  };
  responses["503"] = {
    description: "The WhatsApp service is temporarily unavailable",
    ...jsonBody(ref("Failure")),
  };
  return responses;
};

export function buildOpenApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  const extensionIds = new Set<string>(EXTENSION_ROUTES.map((r) => r.operationId));

  // Extensions are published alongside the cloned surface but labelled, so a reader can tell
  // which endpoints exist upstream and which are ours. Order matters only for readability.
  /**
   * Structural, not `typeof ROUTES`: that is a fixed-length tuple, so concatenating extensions
   * onto it is a type error rather than a wider array. The loop only needs these four fields.
   */
  type AnyRoute = {
    readonly operationId: string;
    readonly method: string;
    readonly path: string;
    readonly pathParams: readonly string[];
    readonly body?: unknown;
  };

  for (const route of [...ROUTES, ...EXTENSION_ROUTES] as readonly AnyRoute[]) {
    const path = route.path;
    paths[path] ??= {};

    const parameters: Record<string, unknown>[] = route.pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    /**
     * A GET carries its inputs in the query string, not a body.
     *
     * The generator derives one `body` schema per route from the mirrored docs and cannot tell
     * the two apart, so `GET /api/contacts`, `GET /api/groups` and the message-log route were
     * being published as GETs with a *required* JSON request body. That is not merely untidy:
     * it is unsendable by most clients, and it hid `?paginated=true` from the reference and the
     * try-it panel entirely.
     */
    const queryFromBody =
      route.method === "GET" && route.body ? jsonSchema(route.body) : null;
    if (queryFromBody && typeof queryFromBody === "object") {
      const props = (queryFromBody as { properties?: Record<string, unknown> }).properties ?? {};
      const required = new Set(
        (queryFromBody as { required?: string[] }).required ?? [],
      );
      for (const [name, schema] of Object.entries(props)) {
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema,
        });
      }
    }

    const patOnly = PAT_ONLY.has(route.operationId as never);

    paths[path]![route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: SUMMARIES[route.operationId] ?? route.operationId,
      description:
        (extensionIds.has(route.operationId)
          ? "**wapi extension.** Not part of the WasenderAPI interface this server reproduces — " +
            "their SDK never calls it, and a drop-in client does not need it.\n\n"
          : "") +
        (patOnly
          ? "Requires a **Personal Access Token**. Session API keys are rejected."
          : "Requires a **Session API Key**. The key identifies the session, so no session id is passed."),
      tags: [tagFor(path)],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body && !queryFromBody
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses: responsesFor(route.operationId),
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
      /**
       * The three failure envelopes, named once and referenced from every operation.
       *
       * They are three rather than one because the original leaks its framework's internals:
       * a handler-decided failure, a middleware-decided failure, and a throttle that
       * short-circuits before the envelope is applied at all.
       */
      schemas: {
        Failure: {
          ...jsonSchema(failureBody),
          description: "Failure decided by a route handler.",
        },
        FrameworkFailure: {
          ...jsonSchema(frameworkFailureBody),
          description: "Failure decided by middleware: authentication, subscription gating.",
        },
        ValidationFailure: {
          ...jsonSchema(frameworkFailureBody),
          description:
            "Validation failure. `errors` maps each rejected field to its messages.",
        },
        ThrottleFailure: {
          ...jsonSchema(throttleBody),
          description: "Rate limited. Deliberately carries no `success` key.",
        },
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
