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
