import type { Handler } from "hono";
import { fail, type RouteDef } from "@wapi/contracts";

/**
 * Placeholder for a Tier-1 route whose handler has not landed yet.
 *
 * Registering every route from day one keeps the surface complete and makes progress
 * measurable: `GET /health` reports the count, and each phase in PLAN.md §8 replaces
 * some of these. A marked 501 is honest in a way a stubbed 200 would not be.
 */
export const notImplemented =
  (route: RouteDef): Handler =>
  (c) =>
    c.json(fail(`${route.operationId} is not implemented yet.`), 501);
