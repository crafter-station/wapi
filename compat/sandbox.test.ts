import { beforeAll, describe, expect, test } from "bun:test";

/**
 * The fidelity surface, asserted against a sandbox session.
 *
 * `integration.test.ts` runs against production with a real linked number. That suite has caught
 * real Baileys behaviour and must keep existing — but it can only ever report a bad deploy, never
 * prevent one, and most of what it asserts is *our* envelopes rather than WhatsApp's behaviour.
 *
 * This file is the half that can run before shipping. It needs no phone, no QR and no real
 * number, so CI can boot the whole stack against an empty database and check the envelopes,
 * pagination arithmetic, credential rules and error shapes that the SDKs and every consumer
 * depend on.
 *
 * The split is by *what a test proves*, not by convenience:
 *
 *   - here — response envelopes, status codes, validation, pagination, auth boundaries
 *   - there — that Baileys actually delivers a message to a real phone
 *
 * A fake cannot catch what a fake does not do, and pretending otherwise would be the tempting
 * mistake. Nothing in this file asserts WhatsApp behaviour.
 *
 * Points at `WAPI_BASE_URL` — a locally booted stack in CI, or a deployment when run by hand.
 */
const BASE = process.env["WAPI_BASE_URL"] ?? "http://127.0.0.1:3101";
const PAT = process.env["WAPI_PAT"] ?? "";
const CAN_RUN = Boolean(PAT);
const d = CAN_RUN ? describe : describe.skip;

/**
 * Whether this deployment has object storage.
 *
 * Probed rather than configured, so nobody has to remember a flag. CI runs Postgres and Redis but
 * no bucket, and `/api/upload` correctly 503s there — failing on that would be the suite
 * reporting a missing dependency as a broken envelope. The upload envelope stays covered by
 * `integration.test.ts`, which runs against a deployment that does have storage.
 *
 * Top-level await: the flag has to exist before the tests are defined, since `skipIf` is
 * evaluated then and not when they run.
 */
const HAS_STORAGE = CAN_RUN
  ? await fetch(`${BASE}/health`)
      .then((r) => r.json() as Promise<{ storage?: boolean }>)
      .then((h) => h.storage === true)
      .catch(() => false)
  : false;

let sessionId = 0;
let key = "";

const api = (path: string, init: RequestInit = {}, token = key) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const json = async (r: Response) => ({ body: (await r.json()) as Record<string, unknown>, status: r.status });

beforeAll(async () => {
  if (!CAN_RUN) return;
  const created = await json(
    await api("/api/sandbox/sessions", { body: JSON.stringify({ name: "ci" }), method: "POST" }, PAT),
  );
  const session = created.body["data"] as { id: number; api_key: string } | undefined;
  /**
   * Say what went wrong, rather than dying on `session.id` two lines later.
   *
   * The first CI run failed here with "undefined is not an object", which is true and useless —
   * the actual cause was a 500 from a malformed ENCRYPTION_KEY, and the response body said so.
   */
  if (!session?.api_key) {
    throw new Error(`could not create a sandbox session (${created.status}): ${JSON.stringify(created.body)}`);
  }
  sessionId = session.id;
  key = session.api_key;

  await api(`/api/whatsapp-sessions/${sessionId}/connect`, { method: "POST" }, PAT);
  // The fake pairs itself, but waiting on a timer makes a flaky suite. Ask it to finish now.
  await api("/api/sandbox/scan", { body: "{}", method: "POST" });

  for (let i = 0; i < 20; i++) {
    const status = (await json(await api("/api/status"))).body["status"];
    if (status === "connected") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("sandbox session never connected");
});

// ---------------------------------------------------------------------------------------
d("credentials", () => {
  test("missing credential returns their exact string", async () => {
    const r = await json(await fetch(`${BASE}/api/whatsapp-sessions`));
    expect(r.status).toBe(401);
    expect(r.body["message"]).toBe("API key is required");
  });

  test("invalid credential returns their exact string", async () => {
    const r = await json(await api("/api/status", {}, "nope"));
    expect(r.status).toBe(401);
    expect(r.body["message"]).toBe("Invalid API key");
  });

  test("wrong credential *kind* is 403, not 401", async () => {
    // The distinction every SDK exposes: valid token, wrong sort. A config mistake, not a bad key.
    expect((await json(await api("/api/whatsapp-sessions"))).status).toBe(403);
    expect((await json(await api("/api/status", {}, PAT))).status).toBe(403);
  });
});

d("the five success envelopes", () => {
  test("GET /api/status is a bare object with no success wrapper", async () => {
    const r = await json(await api("/api/status"));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["status"]);
  });

  test("most routes wrap in {success, data}", async () => {
    const r = await json(await api("/api/user"));
    expect(r.body["success"]).toBe(true);
    expect(r.body["data"]).toBeTruthy();
  });

  test("regenerate-key puts api_key at the TOP level", async () => {
    const r = await json(
      await api(`/api/whatsapp-sessions/${sessionId}/regenerate-key`, { method: "POST" }, PAT),
    );
    expect(typeof r.body["api_key"]).toBe("string");
    expect(r.body["data"]).toBeUndefined();
    key = r.body["api_key"] as string; // the old one is dead from here on
  });

  test.skipIf(!HAS_STORAGE)("upload puts publicUrl at the TOP level", async () => {
    const r = await json(
      await api("/api/upload", {
        body: JSON.stringify({ base64: "aGVsbG8=", mimetype: "text/plain" }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
    expect(typeof r.body["publicUrl"]).toBe("string");
    expect(r.body["data"]).toBeUndefined();
  });

  test("restart returns message at the top level", async () => {
    const r = await json(
      await api(`/api/whatsapp-sessions/${sessionId}/restart`, { method: "POST" }, PAT),
    );
    expect(typeof r.body["message"]).toBe("string");

    /**
     * Restart genuinely re-pairs, on a sandbox exactly as on a real session — so the session is
     * back at `need_scan` and everything after this would race the auto-pair timer. That is
     * correct behaviour, not a quirk to work around, so the test restores the state it disturbed
     * rather than the engine being changed to make testing easier.
     */
    await api("/api/sandbox/scan", { body: "{}", method: "POST" });
    for (let i = 0; i < 20; i++) {
      if ((await json(await api("/api/status"))).body["status"] === "connected") return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("session did not come back after restart");
  });
});

d("the failure envelopes", () => {
  test("controller failures use `error`, framework failures use `message`", async () => {
    const controller = await json(
      await api("/api/messages/read", { body: JSON.stringify({ key: {} }), method: "POST" }),
    );
    expect(controller.status).toBe(422);
    expect(typeof controller.body["error"]).toBe("string");
    expect(controller.body["message"]).toBeUndefined();

    const framework = await json(await api("/api/definitely-not-a-route"));
    expect(framework.status).toBe(404);
    expect(typeof framework.body["message"]).toBe("string");
    expect(framework.body["error"]).toBeUndefined();
  });

  test("validation errors use Laravel phrasing and per-field arrays", async () => {
    const r = await json(
      await api("/api/whatsapp-sessions", { body: JSON.stringify({ name: "x" }), method: "POST" }, PAT),
    );
    expect(r.status).toBe(422);
    expect(r.body["message"]).toBe("Validation failed");
    expect((r.body["errors"] as Record<string, string[]>)["phone_number"]?.[0]).toBe(
      "The phone_number field is required.",
    );
  });

  test("rate-limit headers are on every response", async () => {
    const r = await api("/api/status");
    expect(r.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect(r.headers.get("x-ratelimit-remaining")).toBeTruthy();
    expect(r.headers.get("x-ratelimit-reset")).toBeTruthy();
  });
});

/**
 * `?paginated=true` — the undocumented directory envelope.
 *
 * Found by reading a real consumer (`cuevaio/normal`'s `packages/wasender/src/directory.ts`)
 * rather than the published docs, which only describe the flat array. That consumer rejects the
 * whole page unless the arithmetic matches exactly, so these assertions replicate its validation
 * instead of merely checking that fields exist.
 *
 * These moved here from `integration.test.ts`, and got stricter on the way: the fake's directory
 * is a known size, so `total` is an exact number rather than "at least as many as returned".
 */
d("pagination", () => {
  const check = (payload: Record<string, unknown>, expectedPage: number) => {
    const data = payload["data"] as Record<string, unknown>;
    const items = data["items"] as unknown[];
    const p = data["pagination"] as Record<string, number>;
    expect(Array.isArray(items)).toBe(true);
    expect(p["page"]).toBe(expectedPage);
    expect(items.length).toBeLessThanOrEqual(p["limit"]!);
    // The check a real consumer performs, and rejects the whole page over.
    expect(p["totalPages"]).toBe(Math.max(1, Math.ceil(p["total"]! / p["limit"]!)));
  };

  test("contacts paginate with consistent arithmetic", async () => {
    const r = await json(await api("/api/contacts?paginated=true&page=1&limit=2"));
    expect(r.status).toBe(200);
    check(r.body, 1);
    // The fake's directory is deterministic, so this is an exact expectation rather than a range.
    expect((r.body["data"] as Record<string, unknown>)["pagination"]).toMatchObject({ total: 5 });
  });

  test("groups too, and limit defaults to their documented 20", async () => {
    const r = await json(await api("/api/groups?paginated=true"));
    check(r.body, 1);
    expect((r.body["data"] as Record<string, unknown>)["pagination"]).toMatchObject({
      limit: 20,
      total: 2,
    });
  });

  test("without the flag the shape is a flat array, not a page", async () => {
    const r = await json(await api("/api/contacts"));
    expect(Array.isArray(r.body["data"])).toBe(true);
  });
});

d("directory shapes", () => {
  test("contacts carry both key spellings and the documented nullable fields", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as Record<string, unknown>[];
    const first = contacts[0]!;
    // A consumer rejects an entry where both are present and differ.
    expect(first["jid"]).toBe(first["id"]);
    for (const k of ["name", "notify", "verifiedName", "imgUrl", "status"]) {
      expect(k in first).toBe(true);
    }
  });

  test("groups carry jid/id and name/subject, and metadata agrees with the listing", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as Record<string, unknown>[];
    const g = groups[0]!;
    expect(g["jid"]).toBe(g["id"]);
    expect(g["name"]).toBe(g["subject"]);

    const meta = (
      await json(await api(`/api/groups/${encodeURIComponent(String(g["jid"]))}/metadata`))
    ).body["data"] as Record<string, unknown>;
    expect(meta["jid"]).toBe(g["jid"]);
  });

  test("participants carry both documented forms", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as Record<string, unknown>[];
    const jid = encodeURIComponent(String(groups[0]!["jid"]));
    const parts = (await json(await api(`/api/groups/${jid}/participants`))).body["data"] as Record<
      string,
      unknown
    >[];
    expect(parts[0]).toHaveProperty("jid");
    expect(parts[0]).toHaveProperty("isAdmin");
    expect(parts[0]).toHaveProperty("id");
  });

  test("an unknown LID returns 404 rather than a guessed number", async () => {
    // Never derive a phone number from a LID; the miss is a normal outcome.
    expect((await json(await api("/api/pn-from-lid/1@lid"))).status).toBe(404);
  });
});

d("sending", () => {
  test("a send returns msgId, jid and status", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as Record<string, unknown>[];
    const r = await json(
      await api("/api/send-message", {
        body: JSON.stringify({ text: "ci", to: contacts[0]!["jid"] }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
    const data = r.body["data"] as Record<string, unknown>;
    expect(typeof data["msgId"]).toBe("number");
    expect(typeof data["status"]).toBe("string");
  });

  test("two MEDIA fields is an error, not a silent preference", async () => {
    // `text` alongside `imageUrl` is a caption, which is documented and valid — the exclusion is
    // between media kinds. Getting this wrong the first time is exactly why the test exists.
    const r = await json(
      await api("/api/send-message", {
        body: JSON.stringify({
          imageUrl: "https://x/y.png",
          to: "+99900000001001",
          videoUrl: "https://x/y.mp4",
        }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(422);
    // The *framework* envelope, not the controller one: this is caught by validation, so the
    // detail lives in `errors` per field while `message` stays Laravel's generic phrasing.
    expect(r.body["message"]).toBe("Validation failed");
    const errors = r.body["errors"] as Record<string, string[]>;
    expect(Object.values(errors).flat().join(" ")).toContain("Only one of");
  });

  test("but text alongside a media URL is a caption, and allowed", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as Record<string, unknown>[];
    const r = await json(
      await api("/api/send-message", {
        body: JSON.stringify({
          imageUrl: "https://example.com/photo.png",
          text: "a caption",
          to: contacts[0]!["jid"],
        }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
  });

  test("/info reports WhatsApp's types, not the send's", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as Record<string, unknown>[];
    const sent = await json(
      await api("/api/send-message", {
        body: JSON.stringify({ text: "typed", to: contacts[0]!["jid"] }),
        method: "POST",
      }),
    );
    const msgId = (sent.body["data"] as Record<string, unknown>)["msgId"];
    const info = await json(await api(`/api/messages/${msgId}/info`));
    const data = info.body["data"] as Record<string, unknown>;
    // A protobuf int64 on the wire, and WhatsApp's numeric ack — both differ from a send.
    expect(typeof data["messageTimestamp"]).toBe("string");
    expect(typeof data["status"]).toBe("number");
  });
});

/**
 * Group mutations, exercised for the first time.
 *
 * These routes shipped untested, and not by oversight: testing them against a real number means
 * creating a real group and adding real people to it, which is the exact mistake this repo has
 * already made once. The sandbox is what makes them safe to run at all, so this block is the
 * clearest case of it paying for itself.
 */
d("group mutations", () => {
  let created: { id: string; participants: { id: string }[] } | null = null;

  test("creating a group returns it, and listing shows it afterwards", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const r = await json(
      await api("/api/groups", {
        body: JSON.stringify({ name: "Launch", participants: [contacts[0]!.jid] }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(201);
    created = (r.body["data"] as { id: string; participants: { id: string }[] });
    expect(created.id).toMatch(/@g\.us$/);

    // The half that used to be missing: a create the listing never reflected.
    const list = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    expect(list.map((g) => g.id)).toContain(created.id);
  });

  test("adding a participant reports per-participant status and takes effect", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const newcomer = contacts[3]!.jid;

    const r = await json(
      await api(`/api/groups/${created!.id}/participants/add`, {
        body: JSON.stringify({ participants: [newcomer] }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body["data"]).toEqual([{ jid: newcomer, status: "200" }]);

    const after = (await json(await api(`/api/groups/${created!.id}/participants`))).body["data"] as {
      id: string;
    }[];
    expect(after.map((p) => p.id)).toContain(newcomer);
  });

  test("adding somebody already in the group is a 409 for that participant, not a failure", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const r = await json(
      await api(`/api/groups/${created!.id}/participants/add`, {
        body: JSON.stringify({ participants: [contacts[3]!.jid] }),
        method: "POST",
      }),
    );
    // The request succeeded; the participant did not. A caller that only checks the HTTP status
    // needs the per-participant status to tell those apart.
    expect(r.status).toBe(200);
    expect(r.body["data"]).toEqual([{ jid: contacts[3]!.jid, status: "409" }]);
  });

  test("removing a participant takes effect", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const leaving = contacts[3]!.jid;
    const r = await json(
      await api(`/api/groups/${created!.id}/participants/remove`, {
        body: JSON.stringify({ participants: [leaving] }),
        method: "POST",
      }),
    );
    expect(r.body["data"]).toEqual([{ jid: leaving, status: "200" }]);

    const after = (await json(await api(`/api/groups/${created!.id}/participants`))).body["data"] as {
      id: string;
    }[];
    expect(after.map((p) => p.id)).not.toContain(leaving);
  });

  test("an empty participants list is refused before anything is attempted", async () => {
    for (const path of ["/api/groups", `/api/groups/${created!.id}/participants/add`]) {
      const body = path === "/api/groups" ? { name: "x", participants: [] } : { participants: [] };
      const r = await json(await api(path, { body: JSON.stringify(body), method: "POST" }));
      expect(r.status).toBe(422);
    }
  });

  test("creating a group needs a name", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const r = await json(
      await api("/api/groups", {
        body: JSON.stringify({ participants: [contacts[0]!.jid] }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("name");
  });
});

d("sandbox controls refuse where they should", () => {
  test("a PAT cannot drive a session-scoped control", async () => {
    const r = await json(
      await api("/api/sandbox/inbound", { body: JSON.stringify({ text: "x" }), method: "POST" }, PAT),
    );
    expect(r.status).toBe(403);
  });

  test("inbound requires text", async () => {
    const r = await json(await api("/api/sandbox/inbound", { body: "{}", method: "POST" }));
    expect(r.status).toBe(422);
  });

  test("and an inbound message comes back with a usable key", async () => {
    const r = await json(
      await api("/api/sandbox/inbound", { body: JSON.stringify({ text: "hello" }), method: "POST" }),
    );
    expect(r.status).toBe(200);
    const key = (r.body["data"] as Record<string, unknown>)["key"] as Record<string, unknown>;
    // fromMe: false is what makes the worker classify this as messages.received.
    expect(key["fromMe"]).toBe(false);
    expect(typeof key["id"]).toBe("string");
  });
});
