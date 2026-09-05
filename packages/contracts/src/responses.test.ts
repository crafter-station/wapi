import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ROUTES } from "./extensions.ts";
import { ROUTES } from "./generated/routes.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { SUCCESS_RESPONSES, type SuccessResponse } from "./responses.ts";

/**
 * Response schemas, checked two ways.
 *
 * The first two tests need no mirror and so run in CI: every route has a response schema, and
 * the published document never contains an empty success schema. The second is the regression
 * guard for the bug that prompted this file — every operation published `data: {}`, which a
 * reader sees as `null`.
 *
 * The third checks our schemas against the mirrored response examples, which is the only ground
 * truth available for the interface being cloned. It skips when the mirror is absent, as the
 * other fixture suite does.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, "../../../docs/wasenderapi/structured/endpoints.json");
const AVAILABLE = existsSync(SPEC);

describe("response schemas", () => {
  test("every route has one", () => {
    const table: Record<string, unknown> = SUCCESS_RESPONSES;
    const missing = ROUTES.filter((r) => table[r.operationId] === undefined).map(
      (r) => `${r.method} ${r.path}`,
    );
    expect(missing).toEqual([]);
  });

  test("and none is stale", () => {
    // Extensions are published in the same document, so they count as known here — see
    // `extensions.ts` for why they are not in ROUTES.
    const known = new Set<string>([
      ...ROUTES.map((r) => r.operationId),
      ...EXTENSION_ROUTES.map((r) => r.operationId),
    ]);
    expect(Object.keys(SUCCESS_RESPONSES).filter((id) => !known.has(id))).toEqual([]);
  });

  test("every extension has a response schema too", () => {
    const table: Record<string, unknown> = SUCCESS_RESPONSES;
    expect(EXTENSION_ROUTES.filter((r) => table[r.operationId] === undefined)).toEqual([]);
  });

  /**
   * Summaries.
   *
   * `buildOpenApiDocument` falls back to the operationId when none is written, which is worse than
   * leaving the field empty: the reference looked populated, so nobody noticed that 26 of the 57
   * endpoints answered "what does this do?" with `getApiGroupsGroupJidInviteLink`. Two more were
   * written against ids that never existed — the path params make them `...PnPn` and `...LidLid` —
   * so they sat in the table doing nothing. Both failures are invisible by eye and obvious here.
   */
  test("every operation has a written summary, not its own id echoed back", () => {
    const doc = buildOpenApiDocument("https://api.wapi.crafter.run") as {
      paths: Record<string, Record<string, { operationId: string; summary?: string }>>;
    };

    const echoed: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.summary || op.summary === op.operationId) {
          echoed.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(echoed).toEqual([]);
  });

  test("and no summary is written for an operation that does not exist", () => {
    const known = new Set<string>([
      ...ROUTES.map((r) => r.operationId),
      ...EXTENSION_ROUTES.map((r) => r.operationId),
    ]);
    const doc = buildOpenApiDocument("https://api.wapi.crafter.run") as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    const published = new Set<string>();
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) published.add(op.operationId);
    }
    // Every id the document publishes is a real route. A summary keyed on anything else is dead
    // weight that reads as coverage.
    expect([...published].filter((id) => !known.has(id))).toEqual([]);
  });

  test("the published document has no empty success schema", () => {
    const doc = buildOpenApiDocument("https://api.wapi.crafter.run") as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const empty: string[] = [];

    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [code, response] of Object.entries(op.responses)) {
          if (!code.startsWith("2") || code === "204") continue;
          const schema = (
            response as {
              content?: { "application/json"?: { schema?: Record<string, unknown> } };
            }
          ).content?.["application/json"]?.schema;
          // The original bug in one assertion: a success response with no schema, or a schema
          // with neither properties nor a union, documents nothing while looking authoritative.
          if (
            schema === undefined ||
            (schema["properties"] === undefined &&
              schema["anyOf"] === undefined &&
              schema["oneOf"] === undefined &&
              schema["$ref"] === undefined)
          ) {
            empty.push(`${method.toUpperCase()} ${path} -> ${code}`);
          }
        }
      }
    }
    expect(empty).toEqual([]);
  });

  test("every operation documents the failure envelopes it can actually return", () => {
    const doc = buildOpenApiDocument("https://api.wapi.crafter.run") as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      "Failure",
      "FrameworkFailure",
      "ThrottleFailure",
      "ValidationFailure",
    ]);

    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const code of ["401", "403", "422", "429", "503"]) {
          expect(op.responses[code]).toBeDefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
type Entry = {
  method: string;
  path: string;
  responses: { title: string | null; json: string | null }[];
};

/** `{whatsappSession}` and `{groupId}` differ from our `{groupJid}`; the shape does not. */
const normalise = (path: string) => path.replace(/\{[^}]+\}/gu, "{}");

const d = AVAILABLE ? describe : describe.skip;

d("mirrored response examples", () => {
  const spec: Entry[] = AVAILABLE ? (JSON.parse(readFileSync(SPEC, "utf8")) as Entry[]) : [];
  const byShape = new Map<string, string>();
  for (const r of ROUTES) byShape.set(`${r.method} ${normalise(r.path)}`, r.operationId);

  const cases = spec.flatMap((e) => {
    const operationId = byShape.get(`${e.method} ${normalise(e.path)}`);
    if (operationId === undefined) return [];
    return (e.responses ?? []).flatMap((r) => {
      // Only success examples: failures are covered by the envelope components above.
      if (!r.json || /error/iu.test(r.title ?? "")) return [];
      try {
        const body: unknown = JSON.parse(r.json);
        /**
         * A few blocks in the mirror are a *list of examples* — `[{title, code}, …]` — rather
         * than one response body. That is a documentation artifact, not a shape to validate.
         */
        const isExampleList =
          Array.isArray(body) &&
          body.every(
            (x) => typeof x === "object" && x !== null && "title" in x && "code" in x,
          );
        if (isExampleList) return [];
        return [{ body, operationId, title: r.title ?? "" }];
      } catch {
        // A few examples embed `// comments` and are prose, not machine-checkable.
        return [];
      }
    });
  });

  test("the mirror actually yielded cases", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  for (const c of cases) {
    const entry = (SUCCESS_RESPONSES as Record<string, SuccessResponse | undefined>)[
      c.operationId
    ];
    if (entry?.schema === undefined) continue;
    test(`${c.operationId} accepts "${c.title}"`, () => {
      const result = entry.schema!.safeParse(c.body);
      if (!result.success) {
        throw new Error(
          `${c.operationId} rejects its own documented example:\n${JSON.stringify(
            result.error.issues.slice(0, 6),
            null,
            2,
          )}`,
        );
      }
    });
  }
});
