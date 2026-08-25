import { failFramework } from "@wapi/contracts";

/**
 * Translate Zod issues into Laravel's validator phrasing.
 *
 * Fidelity detail (PLAN.md §1.4): their documented validation body is
 *
 *   { "success": false, "message": "Validation failed",
 *     "errors": { "to": ["The to field is required."] } }
 *
 * Zod's defaults ("Invalid input: expected string, received undefined") would be a visible
 * divergence in the one error shape clients are most likely to parse and display. This maps
 * the common cases onto Laravel's wording; anything unmapped falls through to Zod's message,
 * which is better than inventing a wrong-sounding sentence.
 */

type Issue = { path: PropertyKey[]; message: string; code?: string; expected?: string };

const fieldName = (path: PropertyKey[]) => (path.length ? path.map(String).join(".") : "_");

function laravelMessage(issue: Issue): string {
  const field = fieldName(issue.path);

  // Zod v4 reports a missing key as an invalid_type whose message names `undefined`.
  if (/received undefined/.test(issue.message)) return `The ${field} field is required.`;

  if (issue.code === "invalid_type" && issue.expected) {
    const laravelType =
      issue.expected === "number" ? "integer" : issue.expected === "boolean" ? "boolean" : issue.expected;
    return `The ${field} must be a ${laravelType}.`;
  }

  if (issue.code === "too_small") return `The ${field} field is required.`;

  return issue.message;
}

/** Build the framework-envelope validation failure from a ZodError. */
export function validationFailure(err: { issues: readonly Issue[] }) {
  const errors: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = fieldName(issue.path);
    (errors[key] ??= []).push(laravelMessage(issue));
  }
  return failFramework("Validation failed", errors);
}


/**
 * Validate a proxy URL.
 *
 * Their documented constraint: "Allowed protocols: http, https, socks5. Use a public domain
 * only (IP addresses and local/private networks are blocked)." The private-range block is a
 * genuine SSRF guard, not decoration — this URL becomes an outbound proxy for our egress.
 *
 * Lives here rather than beside the route because the dashboard sets `proxy_url` too. A
 * security control with two copies is one that gets fixed in one place and stays broken in the
 * other.
 *
 * Returns an error message, or null when the URL is acceptable.
 */
export function validateProxy(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The proxy_url must be a valid URL.";
  }
  if (!["http:", "https:", "socks5:"].includes(u.protocol)) {
    return "Allowed proxy protocols are http, https and socks5.";
  }
  const host = u.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const isPrivate =
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isIp || isPrivate) {
    return "Use a public domain for proxy_url; IP addresses and private networks are blocked.";
  }
  return null;
}
