import "server-only";

/**
 * The dashboard talking to our own public API.
 *
 * Session-scoped reads go through the API rather than straight to Postgres, deliberately: if
 * `/api/contacts` breaks, this dashboard should break with it. Two real fidelity bugs this
 * project shipped were found by an outside consumer rather than by us, which is the argument.
 *
 * Account-scoped data — sessions, tokens, the message log — still reads the database directly.
 * Those routes are PAT-authenticated by the upstream design, and holding an account-level
 * credential in the web app to read our own rows would concentrate exactly the secret we keep
 * out of it.
 *
 * Two base URLs, on purpose:
 *
 *   - **internal** for page renders. No TLS handshake, no public round-trip, no dependency on
 *     outbound DNS from inside the container. It exercises the full API surface, which is what
 *     the dogfooding argument is actually about.
 *   - **edge** for the doctor. Its job is answering "does this work end to end", and there the
 *     proxy and certificate are part of what is being tested.
 */
const INTERNAL = process.env["API_INTERNAL_URL"] ?? "http://api:3001";
const EDGE = process.env["API_PUBLIC_URL"] ?? "https://api.wapi.crafter.run";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Envelope = {
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  [k: string]: unknown;
};

export async function apiFetch(
  key: string,
  path: string,
  opts: { edge?: boolean; init?: RequestInit; timeoutMs?: number } = {},
): Promise<Envelope> {
  const base = opts.edge ? EDGE : INTERNAL;
  const res = await fetch(`${base}${path}`, {
    ...opts.init,
    // Message and contact state changes constantly; a cached read here is always wrong.
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (res.status === 204) return {};
  const body = (await res.json().catch(() => ({}))) as Envelope;
  if (!res.ok) {
    // Both failure envelopes: handlers set `error`, middleware sets `message`. Reading one
    // loses half of them and logs "undefined".
    throw new ApiError(res.status, body.error ?? body.message ?? `request failed (${res.status})`);
  }
  return body;
}

/** Most routes wrap their payload in `data`; a few put it at the top level. */
const unwrap = <T>(body: Envelope): T => (body.data as T) ?? (body as T);

export type Contact = {
  jid: string;
  id: string;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  imgUrl: string | null;
  status: string | null;
  phoneNumber: string | null;
  lid: string | null;
};

export type Participant = {
  jid?: string;
  id?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  admin?: string | null;
};

export type Group = {
  jid: string;
  id?: string;
  name: string;
  subject?: string;
  imgUrl: string | null;
  owner?: string | null;
  creation?: number | null;
  desc?: string | null;
  participants?: Participant[];
};

export type Page<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

/**
 * Paginated reads use the API's own `?paginated=true` mode rather than slicing a full list.
 *
 * A client-side filter over one page is worse than none: it looks correct on a small test
 * account and silently searches only what happens to be loaded on a real one.
 */
export const contactsPage = async (key: string, page: number, limit = 50) =>
  unwrap<Page<Contact>>(
    await apiFetch(key, `/api/contacts?paginated=true&page=${page}&limit=${limit}`),
  );

export const groupsPage = async (key: string, page: number, limit = 50) =>
  unwrap<Page<Group>>(await apiFetch(key, `/api/groups?paginated=true&page=${page}&limit=${limit}`));

export const groupMetadata = async (key: string, jid: string) =>
  unwrap<Group>(await apiFetch(key, `/api/groups/${encodeURIComponent(jid)}/metadata`));

export const groupParticipants = async (key: string, jid: string) =>
  unwrap<Participant[]>(
    await apiFetch(key, `/api/groups/${encodeURIComponent(jid)}/participants`),
  );
