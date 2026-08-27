import "server-only";
import { WapiClient } from "./wapi/index.js";

/**
 * The wapi client, pinned to the server.
 *
 * This file is deliberately thin. Earlier versions of this skill shipped a whole hand-written
 * client — a second implementation of the same API, covering thirteen of its thirty operations
 * and covered by no drift guard. That is a copy that rots. The real client lives in the wapi
 * repository, is checked against the OpenAPI document in CI, and is what you should vendor:
 *
 *     npx giget@latest gh:crafter-station/wapi/sdk/typescript/src src/wapi
 *
 * What remains here is the one thing the SDK cannot express, because it is a Next.js concern
 * rather than an API one: `server-only` turns importing this from a client component into a
 * build error rather than a leaked WhatsApp credential.
 *
 * Copy this file to `src/lib/wapi.ts`, alongside the vendored `src/wapi/`.
 */

if (!process.env["WAPI_API_KEY"]) {
  // Fail at import rather than on the first send, where it would look like an API problem.
  throw new Error("WAPI_API_KEY is not set");
}

export const wapi = new WapiClient({
  apiKey: process.env["WAPI_API_KEY"]!,
  ...(process.env["WAPI_BASE_URL"] ? { baseUrl: process.env["WAPI_BASE_URL"] } : {}),
});

/**
 * Re-exported so a handler can catch these without a second import path.
 *
 * `WapiAuthError.isWrongCredentialType` is the one worth branching on: a `403` means the token
 * was valid but of the wrong *kind* — a session key on an account route, or a PAT on a
 * session-scoped one. That is a configuration mistake, not a bad secret.
 */
export {
  WapiAuthError,
  WapiError,
  WapiRateLimitError,
  WapiUnavailableError,
  WapiValidationError,
} from "./wapi/errors.js";

export type { MessageKey, SendMessageInput } from "./wapi/index.js";
