/**
 * Generates `src/generated/routes.ts` from the locally mirrored WasenderAPI spec.
 *
 * The mirror (`docs/wasenderapi/structured/endpoints.json`) is gitignored — it contains
 * WasenderAPI's copyrighted prose. This generator deliberately emits ONLY interface facts:
 * method, path, operation id, parameter names, types and requiredness. No descriptions,
 * no response examples. Our own prose is authored separately for the docs site.
 *
 * Run: bun run contracts:generate
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, "../../../docs/wasenderapi/structured/endpoints.json");
const OUT = resolve(HERE, "generated/routes.ts");

/** The Tier-1 operations, by `METHOD /path`. See PLAN.md §1. */
const TIER1 = new Set([
  // Sessions (15)
  "POST /api/whatsapp-sessions",
  "GET /api/whatsapp-sessions",
  "GET /api/whatsapp-sessions/{whatsappSession}",
  "PUT /api/whatsapp-sessions/{whatsappSession}",
  "DELETE /api/whatsapp-sessions/{whatsappSession}",
  "POST /api/whatsapp-sessions/{whatsappSession}/connect",
  "POST /api/whatsapp-sessions/{whatsappSession}/disconnect",
  "POST /api/whatsapp-sessions/{whatsappSession}/restart",
  "POST /api/whatsapp-sessions/{whatsappSession}/regenerate-key",
  "GET /api/whatsapp-sessions/{whatsappSession}/qrcode",
  "GET /api/whatsapp-sessions/{whatsappSession}/session-logs",
  "GET /api/fetch-username/{contact_identifier}",
  "POST /api/send-presence-update",
  "GET /api/status",
  "GET /api/user",
  // Messages (9)
  "POST /api/send-message",
  "POST /api/upload",
  "POST /api/decrypt-media",
  "GET /api/messages/{msgId}/info",
  "PUT /api/messages/{msgId}",
  "DELETE /api/messages/{msgId}",
  "POST /api/messages/{message}/resend",
  "POST /api/messages/read",
  "GET /api/whatsapp-sessions/{whatsappSession}/message-logs",
  // Groups (13)
  "GET /api/groups",
  "POST /api/groups",
  "POST /api/groups/{groupId}/leave",
  "PUT /api/groups/{groupId}/participants/update",
  "GET /api/groups/{groupJid}/invite-link",
  "GET /api/groups/{groupJid}/picture",
  "PUT /api/groups/{groupJid}/settings",
  "POST /api/groups/invite/accept",
  "GET /api/groups/invite/{inviteCode}",
  "GET /api/groups/{groupJid}/metadata",
  "GET /api/groups/{groupJid}/participants",
  "POST /api/groups/{groupJid}/participants/add",
  "POST /api/groups/{groupJid}/participants/remove",
  // Contacts (9)
  "GET /api/contacts",
  "PUT /api/contacts",
  "GET /api/contacts/{contactPhoneNumber}",
  "POST /api/contacts/{contactPhoneNumber}/block",
  "POST /api/contacts/{contactPhoneNumber}/unblock",
  "GET /api/contacts/{contactPhoneNumber}/picture",
  "GET /api/on-whatsapp/{contact_identifier}",
  "GET /api/lid-from-pn/{pn}",
  "GET /api/pn-from-lid/{lid}",
]);

/**
 * Which credential each route requires.
 *
 * The mirrored spec does not record this, and until now the only place it existed was 19
 * hand-maintained `app.use` lines in `apps/api/src/index.ts`. Forgetting one there does not fail
 * a test — the route simply mounts unauthenticated, `c.get("auth")` is undefined, and the first
 * request 500s. That happened twice while cloning the last batch of endpoints.
 *
 * Recording it here makes it data: the API derives its middleware from it, the CLI derives which
 * credential to send, and a test asserts every route has one. `TIER1` is already the home for
 * facts about routes the mirror does not carry, so this belongs beside it rather than in a second
 * list with its own drift.
 *
 *   pat     — Personal Access Token. Account-level: the route names its subject in the path.
 *   session — Session API key. The key *is* the selector, so these carry no session id.
 */
const SCOPES: Record<string, "pat" | "session"> = {
  // Everything under /api/whatsapp-sessions names a session by id, so it is account-level.
  "POST /api/whatsapp-sessions": "pat",
  "GET /api/whatsapp-sessions": "pat",
  "GET /api/whatsapp-sessions/{whatsappSession}": "pat",
  "PUT /api/whatsapp-sessions/{whatsappSession}": "pat",
  "DELETE /api/whatsapp-sessions/{whatsappSession}": "pat",
  "POST /api/whatsapp-sessions/{whatsappSession}/connect": "pat",
  "POST /api/whatsapp-sessions/{whatsappSession}/disconnect": "pat",
  "POST /api/whatsapp-sessions/{whatsappSession}/restart": "pat",
  "POST /api/whatsapp-sessions/{whatsappSession}/regenerate-key": "pat",
  "GET /api/whatsapp-sessions/{whatsappSession}/qrcode": "pat",
  "GET /api/whatsapp-sessions/{whatsappSession}/message-logs": "pat",
  "GET /api/whatsapp-sessions/{whatsappSession}/session-logs": "pat",

  // Everything else is scoped by the session key that authenticates it.
  "GET /api/status": "session",
  "GET /api/user": "session",
  "POST /api/send-message": "session",
  "POST /api/upload": "session",
  "POST /api/decrypt-media": "session",
  "GET /api/messages/{msgId}/info": "session",
  "PUT /api/messages/{msgId}": "session",
  "DELETE /api/messages/{msgId}": "session",
  "POST /api/messages/{message}/resend": "session",
  "POST /api/messages/read": "session",
  "POST /api/send-presence-update": "session",
  "GET /api/fetch-username/{contact_identifier}": "session",
  "GET /api/contacts": "session",
  "PUT /api/contacts": "session",
  "GET /api/contacts/{contactPhoneNumber}": "session",
  "POST /api/contacts/{contactPhoneNumber}/block": "session",
  "POST /api/contacts/{contactPhoneNumber}/unblock": "session",
  "GET /api/contacts/{contactPhoneNumber}/picture": "session",
  "GET /api/on-whatsapp/{contact_identifier}": "session",
  "GET /api/lid-from-pn/{pn}": "session",
  "GET /api/pn-from-lid/{lid}": "session",
  "GET /api/groups": "session",
  "POST /api/groups": "session",
  "GET /api/groups/{groupJid}/metadata": "session",
  "GET /api/groups/{groupJid}/participants": "session",
  "POST /api/groups/{groupJid}/participants/add": "session",
  "POST /api/groups/{groupJid}/participants/remove": "session",
  "PUT /api/groups/{groupId}/participants/update": "session",
  "POST /api/groups/{groupId}/leave": "session",
  "GET /api/groups/{groupJid}/invite-link": "session",
  "GET /api/groups/{groupJid}/picture": "session",
  "PUT /api/groups/{groupJid}/settings": "session",
  "POST /api/groups/invite/accept": "session",
  "GET /api/groups/invite/{inviteCode}": "session",
};

type SpecParam = { name: string; type: string; required: boolean };
type SpecEntry = {
  category: string;
  slug: string;
  title: string;
  method: string;
  path: string;
  parameters: SpecParam[];
};

/** Header params documented alongside body params; not part of a request body. */
const HEADER_PARAMS = new Set(["Authorization", "Content-Type", "X-Webhook-Signature"]);

const zodFor = (type: string): string => {
  switch (type) {
    case "string":
      return "z.string()";
    case "boolean":
      return "z.boolean()";
    case "integer":
      return "z.number().int()";
    case "string[]":
      return "z.array(z.string())";
    case "array":
      return "z.array(z.unknown())";
    case "object":
      return "z.record(z.string(), z.unknown())";
    case "binary":
      return "z.unknown()";
    default:
      throw new Error(`unmapped parameter type: ${type}`);
  }
};

const camel = (s: string) =>
  s.replace(/[-_/](\w)/g, (_, c: string) => c.toUpperCase()).replace(/[^\w]/g, "");

const pathParams = (path: string): string[] =>
  [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

const spec: SpecEntry[] = JSON.parse(readFileSync(SPEC, "utf8"));

/**
 * `POST /api/send-message` is documented 14 times, once per message kind. It is ONE
 * endpoint, so the variants are merged: `to` is the only universally required field and
 * the content fields become optional, gated by a refinement. See PLAN.md §1.
 */
type Merged = { key: string; method: string; path: string; slugs: string[]; params: Map<string, SpecParam> };
const merged = new Map<string, Merged>();

for (const e of spec) {
  const key = `${e.method} ${e.path}`;
  if (!TIER1.has(key)) continue;
  let m = merged.get(key);
  if (!m) {
    m = { key, method: e.method, path: e.path, slugs: [], params: new Map() };
    merged.set(key, m);
  }
  m.slugs.push(e.slug);
  const pp = new Set(pathParams(e.path));
  for (const p of e.parameters) {
    if (p.name.includes(".") || HEADER_PARAMS.has(p.name) || pp.has(p.name)) continue;
    const prev = m.params.get(p.name);
    // A field required in one variant but absent from another is optional on the merged route.
    if (prev) prev.required = prev.required && p.required;
    else m.params.set(p.name, { ...p });
  }
}

// `to` is required on send-message even though the merge would keep it required anyway;
// every other field there is optional and validated by refinement instead.
const SEND = "POST /api/send-message";
const sendRoute = merged.get(SEND);
if (sendRoute) {
  for (const [name, p] of sendRoute.params) if (name !== "to") p.required = false;
}

/** Content fields for send-message: at least one must be present. */
const SEND_CONTENT = [
  "text",
  "imageUrl",
  "videoUrl",
  "documentUrl",
  "audioUrl",
  "stickerUrl",
  "contact",
  "location",
  "poll",
];

const lines: string[] = [
  "// GENERATED by packages/contracts/src/generate.ts — do not edit by hand.",
  "// Run `bun run contracts:generate` to regenerate.",
  "//",
  "// Interface facts only (method, path, field names/types/requiredness), derived from the",
  "// locally mirrored WasenderAPI specification. Prose is authored separately.",
  "",
  'import { z } from "zod";',
  "",
];

const routeEntries: string[] = [];

for (const m of [...merged.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const opId = camel(`${m.method.toLowerCase()}-${m.path.replace(/[{}]/g, "").replace(/\//g, "-")}`);
  const pp = pathParams(m.path);

  if (pp.length) {
    lines.push(
      `export const ${opId}Params = z.object({ ${pp.map((p) => `${JSON.stringify(p)}: z.string()`).join(", ")} });`,
    );
  }

  let bodyName = "undefined";
  if (m.params.size) {
    bodyName = `${opId}Body`;
    const fields = [...m.params.values()]
      .map((p) => `  ${JSON.stringify(p.name)}: ${zodFor(p.type)}${p.required ? "" : ".optional()"},`)
      .join("\n");
    if (m.key === SEND) {
      lines.push(`export const ${bodyName} = z\n  .object({\n${fields}\n  })`);
      lines.push(
        `  .refine((v) => [${SEND_CONTENT.map((f) => `v[${JSON.stringify(f)}]`).join(", ")}].some((x) => x !== undefined), {`,
      );
      lines.push(
        `    message: "The text field is required when no media is present.",\n    path: ["text"],\n  });`,
      );
    } else {
      lines.push(`export const ${bodyName} = z.object({\n${fields}\n});`);
    }
  }

  lines.push("");
  const scope = SCOPES[m.key];
  if (!scope) {
    console.error(`ERROR: no scope declared for ${m.key} — add it to SCOPES above.`);
    process.exit(1);
  }

  routeEntries.push(
    `  {\n    operationId: ${JSON.stringify(opId)},\n    method: ${JSON.stringify(m.method)},\n` +
      `    path: ${JSON.stringify(m.path)},\n    pathParams: ${JSON.stringify(pp)},\n` +
      `    scope: ${JSON.stringify(scope)},\n` +
      `    body: ${bodyName === "undefined" ? "undefined" : bodyName},\n  }`,
  );
}

lines.push("export const ROUTES = [", routeEntries.join(",\n"), "] as const;", "");
lines.push("export type RouteDef = (typeof ROUTES)[number];", "");

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`generated ${merged.size} Tier-1 routes -> ${OUT}`);
if (merged.size !== TIER1.size) {
  console.error(`WARNING: expected ${TIER1.size} routes, matched ${merged.size}`);
  const missing = [...TIER1].filter((k) => !merged.has(k));
  if (missing.length) console.error("missing:", missing);
  process.exit(1);
}
