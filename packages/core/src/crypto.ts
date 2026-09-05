import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

/**
 * Machine credentials: Personal Access Tokens and per-session API keys.
 *
 * Both are minted, stored and verified by us rather than Clerk — a Clerk API key's subject
 * must be a user or org (a per-WhatsApp-session key has no such subject), verification is a
 * billed network call, and it would put a Clerk round-trip on every send. See PLAN.md §3.
 */

/** 64 hex characters, matching the shape their documentation shows. */
export const generateApiKey = () => randomBytes(32).toString("hex");
export const generatePat = () => `wapi_pat_${randomBytes(32).toString("hex")}`;
export const generateWebhookSecret = () => randomBytes(16).toString("hex");

/**
 * The short code a human reads off a terminal and types into a browser.
 *
 * Eight characters from an alphabet without `0/O/1/I`, because the whole point is that somebody
 * transcribes it by eye and a misread character sends them to a dead end rather than to an error
 * they can act on.
 *
 * It is deliberately *not* the credential. Approving a request needs a signed-in browser, and
 * collecting the minted token needs the high-entropy poll token the CLI keeps to itself — so
 * guessing this code buys an attacker nothing they can use.
 */
export function generateUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** The CLI's half of a device-authorisation request. Never shown to a human. */
export const generatePollToken = () => randomBytes(32).toString("hex");

/**
 * SHA-256 is correct here, deliberately — these are 256-bit random tokens, not passwords.
 * A slow KDF would add latency to every request and defend against nothing, since there is
 * no low-entropy secret to brute-force.
 */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Constant-time compare for anything derived from user input. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Reversible encryption for the session API key.
 *
 * `GET /api/whatsapp-sessions/{id}` returns `api_key` in plaintext, so fidelity forbids
 * storing it hash-only. Rather than keeping it in the clear we store it AES-256-GCM
 * encrypted: identical behaviour on the wire, and a database dump alone does not yield
 * working credentials. `hashToken` is still used for the *lookup* column so authentication
 * never needs to decrypt.
 */
const keyFromEnv = (): Buffer => {
  const raw = process.env["ENCRYPTION_KEY"];
  if (!raw) throw new Error("ENCRYPTION_KEY is not set (32-byte hex)");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of hex");
  return buf;
};

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromEnv(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, ctB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyFromEnv(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Signed media links.
 *
 * `decrypt-media` promises a URL valid for exactly one hour. That URL used to be the object
 * store's own presigned link, which expires correctly but lives on a *different hostname* than
 * the API. Strict clients pin the media host to the provider host and re-validate it on every
 * redirect hop, so a cross-host link — or a redirect to one — is rejected outright before a
 * byte is read. The original serves media from its own domain, so we do too, and the expiry
 * moves here.
 *
 * HMAC over `key|expires` with the same `ENCRYPTION_KEY`. The signature covers the key, so it
 * cannot be moved to another object, and the expiry, so it cannot be extended.
 */
export function signMediaLink(key: string, ttlSeconds: number): { expires: number; sig: string } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { expires, sig: mediaSignature(key, expires) };
}

export function verifyMediaLink(key: string, expires: string, sig: string): boolean {
  const at = Number(expires);
  if (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, mediaSignature(key, at));
}

const mediaSignature = (key: string, expires: number): string =>
  createHmac("sha256", keyFromEnv()).update(`${key}|${expires}`).digest("hex");
