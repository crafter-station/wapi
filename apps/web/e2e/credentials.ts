/**
 * Where the signed-in specs get their identity.
 *
 * The account is a throwaway in a Clerk **development** instance and exists only for this suite.
 * It has no password: sign-in goes by ticket, minted with `CLERK_SECRET_KEY`. That key is the
 * single credential the suite needs, and without it the dashboard specs do not run — a suite that
 * silently signed in as somebody real would be far worse than one that does not run at all.
 */
export const TEST_EMAIL = process.env["E2E_CLERK_EMAIL"] ?? "wapi-e2e+clerk_test@example.com";

/** Written by `auth.setup.ts`, read by every dashboard spec. Gitignored. */
export const STORAGE_STATE = "e2e/.auth/state.json";
