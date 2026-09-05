/**
 * Which command covers which API operation.
 *
 * The SDK drift guard greps each client's source for an operation's URL, because SDK methods
 * contain the URL literally. CLI commands do not — they call SDK methods — so the mapping has to
 * be written down. One table rather than a declaration beside each command: the question this
 * answers is "is anything missing", and that is easier to see in a list than scattered across
 * nine files. `SCOPES` in `packages/contracts/src/generate.ts` is the same shape for the same
 * reason.
 *
 * Both directions are checked by `ops/check-cli-in-sync.mjs`:
 *
 *   - every operation in the contract appears here, or CI fails;
 *   - every command path here resolves in the real command tree, so a rename breaks the build
 *     rather than silently un-covering an operation.
 *
 * What it cannot check is whether `groups leave` really calls `POST /api/groups/{id}/leave`. That
 * is `compat/cli.test.ts`, which runs the commands. This is the cheap question, asked on every
 * push.
 *
 * `wapi api` appears nowhere on purpose. If the escape hatch counted as coverage, the guard would
 * pass on day one and forever, and there would be no pressure to build the surface beside it.
 */
export const COVERAGE: Record<string, string> = {
  // -- sessions (account-level; these name a session in the path) ------------------------------
  "sessions list": "getApiWhatsappSessions",
  "sessions get": "getApiWhatsappSessionsWhatsappSession",
  "sessions create": "postApiWhatsappSessions",
  "sessions update": "putApiWhatsappSessionsWhatsappSession",
  "sessions delete": "deleteApiWhatsappSessionsWhatsappSession",
  "sessions connect": "postApiWhatsappSessionsWhatsappSessionConnect",
  "sessions disconnect": "postApiWhatsappSessionsWhatsappSessionDisconnect",
  "sessions restart": "postApiWhatsappSessionsWhatsappSessionRestart",
  "sessions qr": "getApiWhatsappSessionsWhatsappSessionQrcode",
  "sessions regenerate-key": "postApiWhatsappSessionsWhatsappSessionRegenerateKey",
  "sessions logs messages": "getApiWhatsappSessionsWhatsappSessionMessageLogs",
  "sessions logs activity": "getApiWhatsappSessionsWhatsappSessionSessionLogs",

  // -- messages -------------------------------------------------------------------------------
  "messages send": "postApiSendMessage",
  "messages info": "getApiMessagesMsgIdInfo",
  "messages edit": "putApiMessagesMsgId",
  "messages delete": "deleteApiMessagesMsgId",
  "messages resend": "postApiMessagesMessageResend",
  read: "postApiMessagesRead",
  react: "postApiMessagesReact",

  // -- media ----------------------------------------------------------------------------------
  "media upload": "postApiUpload",
  "media decrypt": "postApiDecryptMedia",

  // -- contacts and identity ------------------------------------------------------------------
  "contacts list": "getApiContacts",
  "contacts get": "getApiContactsContactPhoneNumber",
  "contacts save": "putApiContacts",
  "contacts block": "postApiContactsContactPhoneNumberBlock",
  "contacts unblock": "postApiContactsContactPhoneNumberUnblock",
  "contacts picture": "getApiContactsContactPhoneNumberPicture",
  "on-whatsapp": "getApiOnWhatsappContactIdentifier",
  "lid from-phone": "getApiLidFromPnPn",
  "lid to-phone": "getApiPnFromLidLid",
  username: "getApiFetchUsernameContactIdentifier",
  presence: "postApiSendPresenceUpdate",
  user: "getApiUser",
  status: "getApiStatus",

  // -- groups ---------------------------------------------------------------------------------
  "groups list": "getApiGroups",
  "groups create": "postApiGroups",
  "groups metadata": "getApiGroupsGroupJidMetadata",
  "groups picture": "getApiGroupsGroupJidPicture",
  "groups settings": "putApiGroupsGroupJidSettings",
  "groups leave": "postApiGroupsGroupIdLeave",
  "groups invite-link": "getApiGroupsGroupJidInviteLink",
  "groups by-invite": "getApiGroupsInviteInviteCode",
  "groups join": "postApiGroupsInviteAccept",
  "groups participants list": "getApiGroupsGroupJidParticipants",
  "groups participants add": "postApiGroupsGroupJidParticipantsAdd",
  "groups participants remove": "postApiGroupsGroupJidParticipantsRemove",
  "groups participants update": "putApiGroupsGroupIdParticipantsUpdate",

  // -- sandbox --------------------------------------------------------------------------------
  "sandbox create": "postApiSandboxSessions",
  "sandbox scan": "postApiSandboxScan",
  "sandbox inbound": "postApiSandboxInbound",
  "sandbox thread": "getApiSandboxThread",

  // -- operator -------------------------------------------------------------------------------
  "tokens create": "postApiTokens",
  "tokens list": "getApiTokens",
  "tokens revoke": "deleteApiTokensToken",
  "audit list": "getApiAuditLogs",
  "audit get": "getApiAuditLogsAuditLog",
  dispatches: "getApiDispatches",
};
