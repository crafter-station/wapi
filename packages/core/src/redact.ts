/**
 * Redaction for audit logs.
 *
 * An audit trail that records requests verbatim is a database table containing every API key
 * this system has ever issued. `Authorization` carries a full WhatsApp credential; the session
 * detail and regenerate-key responses carry `api_key` and `webhook_secret` in plaintext because
 * fidelity requires it. None of that may be stored.
 *
 * The design rule here is **allow-list for headers, deny-list for bodies**, and the asymmetry is
 * deliberate. Header names are a small, closed set we control, so listing what may be kept is
 * safe and a new sensitive header is excluded by default. Body shapes are open-ended and vary
 * per endpoint, so an allow-list would silently drop the fields that make an audit log useful —
 * there the deny-list is applied recursively and paired with truncation.
 *
 * Everything below is pure so it can be tested without a request. `redact.test.ts` is the real
 * specification.
 */

/** Kept because they describe the request rather than authorise it. */
const HEADER_ALLOW = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cf-ipcountry",
  "content-length",
  "content-type",
  "origin",
  "referer",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-request-id",
]);

/**
 * Never stored, even truncated or hashed.
 *
 * Listed explicitly rather than relying on the allow-list alone, so that the intent is greppable
 * and a future change that loosens the allow-list still cannot leak these.
 */
const HEADER_DENY = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-gateway-token",
  "x-webhook-signature",
]);

/** Body keys whose values are secrets or credentials, at any depth. */
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "apikeyencrypted",
  "authorization",
  "password",
  "secret",
  "token",
  "webhook_secret",
  "webhooksecret",
]);

/** Body keys that are legitimately enormous — media, not information. */
const BULK_KEYS = new Set(["base64", "data", "buffer", "bytes", "file"]);

export const REDACTED = "[redacted]";

export function redactHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (HEADER_DENY.has(name)) continue;
    if (!HEADER_ALLOW.has(name)) continue;
    out[name] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
  }
  return out;
}

/**
 * Recursively strip secrets and shrink bulk values.
 *
 * `maxString` bounds any single string; an audit row must never be able to hold a 16 MB upload
 * body, and a message that long is not information worth keeping either.
 */
export function redactBody(value: unknown, maxString = 512, depth = 0): unknown {
  // A cycle or an absurdly nested payload must not be able to hang the request path.
  if (depth > 6) return REDACTED;

  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}…[${value.length} chars]` : value;
  }
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    // Keep the shape and the first few entries: a 500-contact response should record that it
    // was a 500-contact response, not reproduce the address book.
    const head = value.slice(0, 5).map((v) => redactBody(v, maxString, depth + 1));
    return value.length > 5 ? [...head, `…${value.length - 5} more`] : head;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (SECRET_KEYS.has(k)) {
      out[key] = REDACTED;
    } else if (BULK_KEYS.has(k) && typeof v === "string") {
      out[key] = `${REDACTED} (${v.length} chars)`;
    } else {
      out[key] = redactBody(v, maxString, depth + 1);
    }
  }
  return out;
}

/**
 * Parse, redact and re-serialise a body, bounded overall.
 *
 * Non-JSON bodies are described rather than stored: a raw 16 MB image upload has nothing worth
 * auditing beyond its size, and keeping it would make the audit table larger than the media
 * store it is auditing.
 */
export function redactPayload(
  raw: string | null,
  contentType: string | null,
  maxTotal = 4096,
): string | null {
  if (raw === null || raw === "") return null;
  if (contentType && !contentType.includes("json")) {
    return `${REDACTED} (${contentType.split(";")[0]}, ${raw.length} bytes)`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `${REDACTED} (unparseable, ${raw.length} bytes)`;
  }
  const text = JSON.stringify(redactBody(parsed));
  return text.length > maxTotal ? `${text.slice(0, maxTotal)}…` : text;
}

/**
 * The caller's address, from the proxy that actually terminated the connection.
 *
 * `x-forwarded-for` is a client-controllable list; only the *last* entry is appended by our own
 * proxy, so the leftmost value — the one usually treated as "the client IP" — is whatever the
 * caller chose to claim. We take the first entry because it is the useful one for an audit
 * trail, and it is recorded as a claim rather than trusted for any decision.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = headers.get("x-forwarded-for");
  if (!fwd) return null;
  const first = fwd.split(",")[0]?.trim();
  return first || null;
}
