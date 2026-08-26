import { z } from "zod";

/**
 * Response schemas, per operation.
 *
 * `openapi.ts` promises that a route which changes shape changes its documentation in the same
 * commit or fails CI. That promise only ever covered *requests*: every operation published the
 * same `{success, data}` stub where `data` was the empty schema. An empty schema is not "any
 * object" to a reader or to a client generator — Scalar renders it as `null`, so the published
 * reference showed all 29 endpoints returning nothing. That is worse than having no schema at
 * all, because it looks authoritative.
 *
 * These are derived from the mirrored spec's response examples, and `responses.test.ts`
 * validates them against those examples, so drift from the interface being cloned fails CI
 * rather than being discovered by a caller.
 *
 * Where their example and our behaviour differ the difference is deliberate and noted at the
 * schema. Where they document no success example at all — the qrcode route — the schema
 * describes what we return and says so.
 */

/** Genuinely opaque provider payloads: a WhatsApp message node, a message key. */
const unknownJson = z.any();

// ------------------------------------------------------------------------------- failures
export const failureBody = z.object({
  success: z.literal(false),
  error: z.string(),
});

export const frameworkFailureBody = z.object({
  success: z.literal(false),
  message: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});

/** Note the deliberate absence of a `success` key — Laravel short-circuits before the envelope. */
export const throttleBody = z.object({
  message: z.string(),
  retry_after: z.number().int(),
});

// --------------------------------------------------------------------------------- pieces
const ok = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), data });

const sessionSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  phone_number: z.string(),
  status: z.string(),
  account_protection: z.boolean(),
  log_messages: z.boolean(),
  webhook_url: z.string().nullable(),
  webhook_enabled: z.boolean(),
  // Nullable: their own list example carries a session with no events configured.
  webhook_events: z.array(z.string()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** The detail shape additionally carries the credential, which the list shape must never. */
const sessionDetail = sessionSummary.extend({
  api_key: z.string().nullable(),
  webhook_secret: z.string().nullable(),
});

/**
 * Contacts come in two shapes, and the difference is theirs, not ours.
 *
 * The list keys each row on `jid`; the single-contact detail keys it on `id`. We emit both keys
 * with the same value in both places, so each schema requires the one their example requires
 * and marks the other optional.
 */
const contactFields = {
  name: z.string().nullable(),
  notify: z.string().nullable(),
  verifiedName: z.string().nullable(),
  imgUrl: z.string().nullable(),
  status: z.string().nullable(),
};

const contactDetail = z.object({
  id: z.string(),
  jid: z.string().optional(),
  ...contactFields,
  phoneNumber: z.string().nullable().optional(),
  lid: z.string().nullable().optional(),
});

const contactEntry = z.object({
  jid: z.string(),
  id: z.string().optional(),
  ...contactFields,
  phoneNumber: z.string().nullable().optional(),
  lid: z.string().nullable().optional(),
});

/**
 * Participants also come in two shapes in their own documentation: the metadata route nests
 * `{jid, isAdmin, isSuperAdmin}`, while the participants route returns `{id}`. We emit every
 * key in both places, so each schema requires what that route's example requires.
 */
const participantFields = {
  jid: z.string().optional(),
  isAdmin: z.boolean().optional(),
  isSuperAdmin: z.boolean().optional(),
  id: z.string().optional(),
  admin: z.string().nullable().optional(),
};

const participantInMetadata = z.object({
  ...participantFields,
  jid: z.string(),
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
});

const participantListItem = z.object({ ...participantFields, id: z.string() });

/**
 * Groups likewise: their list row is `{jid, name, imgUrl}` while their metadata body is
 * `{jid, subject, creation, owner, desc, participants}`. One is not a subset of the other, so
 * they are two schemas rather than one weakened to fit both. Our single serializer emits the
 * union, which satisfies each.
 */
const groupFields = {
  jid: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  subject: z.string().optional(),
  imgUrl: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  creation: z.number().int().nullable().optional(),
  desc: z.string().nullable().optional(),
};

const groupListItem = z.object({
  ...groupFields,
  name: z.string(),
  imgUrl: z.string().nullable(),
  participants: z.array(participantInMetadata).optional(),
});

const groupMetadata = z.object({
  ...groupFields,
  subject: z.string(),
  participants: z.array(participantInMetadata),
});

/** The paginated page adds the two keys a directory consumer reads. */
const groupEntry = groupListItem.extend({
  notify: z.null().optional(),
  verifiedName: z.null().optional(),
});

const pagination = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const directoryPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), pagination });

/** Laravel's length-aware paginator, minus the `links` array it normally includes. */
const laravelPage = <T extends z.ZodTypeAny>(row: T) =>
  z.object({
    current_page: z.number().int(),
    data: z.array(row),
    first_page_url: z.string(),
    from: z.number().int().nullable(),
    last_page: z.number().int(),
    last_page_url: z.string(),
    next_page_url: z.string().nullable(),
    path: z.string(),
    per_page: z.number().int(),
    prev_page_url: z.string().nullable(),
    to: z.number().int().nullable(),
    total: z.number().int(),
  });

/** Their log row: ids are strings, the recipient is `to`, and `content` is a JSON string. */
const messageLogRow = z.object({
  id: z.string(),
  whatsapp_session_id: z.string(),
  to: z.string().nullable(),
  content: z.string().nullable(),
  status: z.string().nullable(),
  failed_reason: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const participantResult = z.object({
  status: z.number().int(),
  jid: z.string(),
  message: z.string(),
});

export type SuccessResponse =
  | { status: number; schema: z.ZodTypeAny }
  | { status: 204; schema?: undefined };

/**
 * Success bodies keyed by operationId.
 *
 * Not every entry is `{success, data}`, and that is the point of the project rather than an
 * inconsistency to tidy: five distinct success envelopes appear across these 29 routes.
 * `getApiStatus` is a bare `{status}` with no wrapper, regenerate-key puts `api_key` at the top
 * level, upload and decrypt-media put `publicUrl` there, restart returns `message`, and delete
 * returns no body at all.
 */
export const SUCCESS_RESPONSES: Record<string, SuccessResponse> = {
  // -- sessions (account-scoped)
  getApiWhatsappSessions: { status: 200, schema: ok(z.array(sessionSummary)) },
  postApiWhatsappSessions: { status: 201, schema: ok(sessionDetail) },
  getApiWhatsappSessionsWhatsappSession: { status: 200, schema: ok(sessionDetail) },
  putApiWhatsappSessionsWhatsappSession: { status: 200, schema: ok(sessionDetail) },
  deleteApiWhatsappSessionsWhatsappSession: { status: 204 },
  postApiWhatsappSessionsWhatsappSessionRegenerateKey: {
    status: 200,
    // `api_key` sits at the TOP level here, not under `data`.
    schema: z.object({ success: z.literal(true), api_key: z.string() }),
  },
  postApiWhatsappSessionsWhatsappSessionConnect: {
    status: 200,
    // `status` is SCREAMING_CASE in connect responses and lowercase everywhere else.
    schema: ok(
      z.object({
        status: z.string(),
        qrCode: z.string().optional(),
        message: z.string().optional(),
      }),
    ),
  },
  postApiWhatsappSessionsWhatsappSessionDisconnect: {
    status: 200,
    schema: ok(z.object({ status: z.string(), message: z.string() })),
  },
  postApiWhatsappSessionsWhatsappSessionRestart: {
    status: 200,
    schema: z.object({ success: z.literal(true), message: z.string() }),
  },
  getApiWhatsappSessionsWhatsappSessionQrcode: {
    status: 200,
    // Their spec documents only failures for this route; this is our own shape.
    schema: ok(z.object({ qrCode: z.string() })),
  },
  getApiWhatsappSessionsWhatsappSessionMessageLogs: {
    status: 200,
    schema: ok(laravelPage(messageLogRow)),
  },

  // -- connection (session-scoped)
  getApiStatus: {
    status: 200,
    // A bare object with no `success` wrapper at all.
    schema: z.object({ status: z.string() }),
  },
  getApiUser: {
    status: 200,
    schema: ok(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        lid: z.string().nullable(),
      }),
    ),
  },

  // -- messages
  postApiSendMessage: {
    status: 200,
    schema: ok(z.object({ msgId: z.number().int(), jid: z.string(), status: z.string() })),
  },
  getApiMessagesMsgIdInfo: {
    status: 200,
    schema: ok(
      z.object({
        remoteJid: z.string().nullable(),
        id: z.string().nullable(),
        msgId: z.number().int(),
        key: unknownJson,
        message: unknownJson,
        // A protobuf int64, so a string on the wire; and WhatsApp's numeric ack, not our word.
        messageTimestamp: z.string(),
        status: z.number().int(),
      }),
    ),
  },
  postApiMessagesRead: { status: 200, schema: ok(z.object({ status: z.string() })) },
  // wapi extension — see `extensions.ts`. `id` is WhatsApp's id for the reaction message.
  postApiMessagesReact: {
    status: 200,
    schema: ok(z.object({ id: z.string().nullable(), emoji: z.string() })),
  },

  // -- media: `publicUrl` at the top level
  postApiUpload: {
    status: 200,
    schema: z.object({ success: z.literal(true), publicUrl: z.string() }),
  },
  postApiDecryptMedia: {
    status: 200,
    schema: z.object({ success: z.literal(true), publicUrl: z.string() }),
  },

  // -- contacts
  getApiContacts: {
    status: 200,
    // `?paginated=true` changes the shape, so the response is one or the other.
    schema: z.union([ok(z.array(contactEntry)), ok(directoryPage(contactEntry))]),
  },
  getApiContactsContactPhoneNumber: { status: 200, schema: ok(contactDetail) },
  getApiOnWhatsappContactIdentifier: {
    status: 200,
    // `jid` is ours; their documented body is `{exists}` alone.
    schema: ok(z.object({ exists: z.boolean(), jid: z.string().nullable().optional() })),
  },
  getApiLidFromPnPn: { status: 200, schema: ok(z.object({ lid: z.string() })) },
  getApiPnFromLidLid: { status: 200, schema: ok(z.object({ pn: z.string() })) },

  // -- groups
  getApiGroups: {
    status: 200,
    schema: z.union([ok(z.array(groupListItem)), ok(directoryPage(groupEntry))]),
  },
  postApiGroups: { status: 201, schema: ok(groupMetadata) },
  getApiGroupsGroupJidMetadata: { status: 200, schema: ok(groupMetadata) },
  getApiGroupsGroupJidParticipants: {
    status: 200,
    schema: ok(z.array(participantListItem)),
  },
  postApiGroupsGroupJidParticipantsAdd: {
    status: 200,
    schema: ok(z.array(participantResult)),
  },
  postApiGroupsGroupJidParticipantsRemove: {
    status: 200,
    schema: ok(z.array(participantResult)),
  },
};
