/**
 * Response envelopes, reproduced exactly as WasenderAPI emits them.
 *
 * Their API is Laravel, and it leaks three *different* failure shapes depending on where
 * the failure originates. Strict fidelity (PLAN.md §1) means reproducing all three rather
 * than unifying them — their published SDKs parse what Laravel actually produces.
 *
 * Verified against all 68 response examples in the mirrored spec:
 *   - 20/20 per-endpoint (controller) failures use `error`
 *   - 0/20 use `message`
 */

/** `{"success": true, "data": …}` — every successful response. */
export const ok = <T>(data: T) => ({ success: true as const, data });

/**
 * Controller-level business failure: `{"success": false, "error": "…"}`.
 *
 * This is the shape for anything a route handler decides itself — session not connected,
 * message not failed so cannot be resent, group invite invalid, upload too large.
 * It is by far the most common failure shape in the API.
 */
export const fail = (error: string) => ({ success: false as const, error });

/**
 * Framework-level failure: `{"success": false, "message": "…", "errors"?: {…}}`.
 *
 * Laravel's exception handler produces this, so it belongs to middleware concerns —
 * authentication, request validation, subscription gating. `errors` carries the
 * per-field array form Laravel's validator emits.
 */
export const failFramework = (message: string, errors?: Record<string, string[]>) =>
  errors ? { success: false as const, message, errors } : { success: false as const, message };

/**
 * Throttle failure: `{"message": "…", "retry_after": n}`.
 *
 * Note there is deliberately **no `success` key** — Laravel's ThrottleRequests middleware
 * short-circuits before the response envelope is applied. Reproducing this omission is
 * required for fidelity, however odd it looks next to the other two.
 */
export const failThrottle = (message: string, retryAfter: number) => ({
  message,
  retry_after: retryAfter,
});

/**
 * Laravel's length-aware paginator, as their endpoints emit it.
 *
 * Note this is the paginator *without* the `links` array that Laravel includes by default —
 * verified against both paginated examples in the mirrored spec (`message-logs`,
 * `session-logs`). Twelve keys, in this order.
 */
export type Paginated<T> = {
  current_page: number;
  data: T[];
  first_page_url: string;
  from: number | null;
  last_page: number;
  last_page_url: string;
  next_page_url: string | null;
  path: string;
  per_page: number;
  prev_page_url: string | null;
  to: number | null;
  total: number;
};

export const paginate = <T>(args: {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  path: string;
}): Paginated<T> => {
  const { items, page, perPage, total, path } = args;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number) => `${path}?page=${p}`;
  const from = items.length ? (page - 1) * perPage + 1 : null;
  const to = items.length ? (page - 1) * perPage + items.length : null;
  return {
    current_page: page,
    data: items,
    first_page_url: url(1),
    from,
    last_page: lastPage,
    last_page_url: url(lastPage),
    next_page_url: page < lastPage ? url(page + 1) : null,
    path,
    per_page: perPage,
    prev_page_url: page > 1 ? url(page - 1) : null,
    to,
    total,
  };
};

/**
 * The paginated directory envelope, used by `?paginated=true` on contacts and groups.
 *
 * This is a SECOND, different pagination shape from the Laravel paginator above — `items` plus
 * a `pagination` object rather than the twelve-key length-aware paginator. Both are documented
 * by the original; `message-logs` and `session-logs` use the Laravel paginator, while contacts
 * and groups use this one behind `?paginated=true`.
 *
 * Two pagination shapes in one API is not a design we would choose. It is the interface we are
 * cloning, and a client that asks for `paginated=true` and receives the flat array fails on
 * its first call — consumers validate this strictly and reject the response outright unless
 * `totalPages === max(1, ceil(total / limit))`.
 */
export type DirectoryPage<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export const directoryPage = <T>(args: {
  items: T[];
  page: number;
  limit: number;
  total: number;
}): DirectoryPage<T> => {
  const { items, page, limit, total } = args;
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      // Must match the consumer's own arithmetic exactly or the response is rejected.
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

/** The seven session statuses. Lowercase here; SCREAMING in connect responses — see PLAN.md §1.3. */
export const SESSION_STATUSES = [
  "connecting",
  "connected",
  "disconnected",
  "need_scan",
  "need_passkey",
  "logged_out",
  "expired",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
