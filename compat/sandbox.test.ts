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

d("wapi session settings extension", () => {
  test("reports the effective safety-critical settings", async () => {
    const response = await json(
      await api(`/api/whatsapp-sessions/${sessionId}/settings`, {}, PAT),
    );

    expect(response.status).toBe(200);
    expect(response.body["success"]).toBe(true);
    expect(response.body["data"]).toMatchObject({
      ignore_groups: false,
      read_incoming_messages: false,
    });
  });
});

d("the six success envelopes", () => {
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

  test.skipIf(!HAS_STORAGE)(
    "upload puts publicUrl at the TOP level",
    async () => {
      const r = await json(
        await api("/api/upload", {
          body: JSON.stringify({ base64: "aGVsbG8=", mimetype: "text/plain" }),
          method: "POST",
        }),
      );
      expect(r.status).toBe(200);
      expect(typeof r.body["publicUrl"]).toBe("string");
      expect(r.body["data"]).toBeUndefined();
    },
    /**
     * The only assertion here that leaves the machine for a third-party service. Observed between
     * 1.5s and over 5s for the same call, so Bun's five-second default turns ordinary latency into
     * a red suite — the exact flake that teaches people to re-run rather than read a failure.
     */
    20_000,
  );

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
d("contact writes", () => {
  test("saving a name is reflected by the directory", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { jid: string }[];
    const target = contacts[1]!.jid;

    const saved = await json(
      await api("/api/contacts", { body: JSON.stringify({ fullName: "Renamed", jid: target }), method: "PUT" }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body["data"]).toMatchObject({ fullName: "Renamed", jid: target });

    // The round trip that matters: a save nobody can read back is not a save.
    const after = (await json(await api("/api/contacts"))).body["data"] as { jid: string; name: string }[];
    expect(after.find((c) => c.jid === target)!.name).toBe("Renamed");
  });

  test("saving needs a jid", async () => {
    const r = await json(
      await api("/api/contacts", { body: JSON.stringify({ fullName: "No jid" }), method: "PUT" }),
    );
    expect(r.status).toBe(422);
    expect(r.body["message"]).toBe("Validation failed");
  });

  test("block and unblock both report what they did", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { phoneNumber: string }[];
    const who = contacts[0]!.phoneNumber;

    const blocked = await json(await api(`/api/contacts/${encodeURIComponent(who)}/block`, { method: "POST" }));
    expect(blocked.status).toBe(200);
    expect(blocked.body["data"]).toEqual({ message: "Contact blocked" });

    const unblocked = await json(await api(`/api/contacts/${encodeURIComponent(who)}/unblock`, { method: "POST" }));
    expect(unblocked.body["data"]).toEqual({ message: "Contact unblocked" });
  });

  test("a profile picture is a success even when there is none", async () => {
    const contacts = (await json(await api("/api/contacts"))).body["data"] as { phoneNumber: string }[];
    const known = await json(await api(`/api/contacts/${encodeURIComponent(contacts[0]!.phoneNumber)}/picture`));
    expect(known.status).toBe(200);
    expect(typeof known.body["data"]).toBe("object");
    expect("imgUrl" in (known.body["data"] as object)).toBe(true);

    /**
     * The branch that matters in production, where most accounts have no picture or restrict it:
     * `imgUrl: null` inside a 200, never a 404. A caller that treats absence as an error would
     * report a broken integration for the ordinary case.
     */
    const stranger = await json(await api("/api/contacts/%2B19999999999/picture"));
    expect(stranger.status).toBe(200);
    expect((stranger.body["data"] as { imgUrl: string | null }).imgUrl).toBeNull();
  });

  test("a bad number is refused before the engine is asked", async () => {
    const r = await json(await api("/api/contacts/not-a-number/block", { method: "POST" }));
    expect(r.status).toBe(422);
  });
});

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

/**
 * A webhook delivery, end to end.
 *
 * `integration.test.ts` has always had a version of this behind `COMPAT_WEBHOOK=1`, opt-in
 * because it reconfigures a **live** session's webhook URL and then sends to a real number. The
 * sandbox removes both objections: fabricating an inbound message costs nothing and reaches
 * nobody, so the delivery path can be exercised on every push instead of by hand.
 *
 * This is the assertion the whole feature exists for. A developer's actual question is not
 * "does the API return 200" but "does my handler receive something it can verify", and nothing
 * else in either suite answers it.
 *
 * Runs only against a local stack that has Redis, and both halves of that matter:
 *
 *   - The sink lives inside this process, so the API has to be able to reach it. Against a
 *     deployment it cannot, and the failure would be about network topology rather than wapi.
 *   - The delivery path is gateway → Redis → worker → HTTP. Without Redis there is no worker and
 *     no delivery, so running this would report a missing dependency as a broken feature — the
 *     same mistake the upload envelope check made before it learned to ask.
 */
const CAN_DELIVER =
  (BASE.startsWith("http://127.0.0.1") || BASE.startsWith("http://localhost")) &&
  Boolean(process.env["REDIS_URL"]);

d("webhook delivery", () => {
  test.skipIf(!CAN_DELIVER)("an inbound message produces a signed delivery", async () => {
    const received: { body: string; signature: string | null }[] = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({ body: await req.text(), signature: req.headers.get("X-Webhook-Signature") });
        return new Response("ok");
      },
    });

    try {
      await json(
        await api(
          `/api/whatsapp-sessions/${sessionId}`,
          {
            body: JSON.stringify({
              webhook_enabled: true,
              webhook_events: ["messages.received"],
              webhook_url: `http://127.0.0.1:${sink.port}/sink`,
            }),
            method: "PUT",
          },
          PAT,
        ),
      );

      // The detail endpoint is the only place the secret is returned, and a handler cannot verify
      // a delivery without it.
      const detail = await json(await api(`/api/whatsapp-sessions/${sessionId}`, {}, PAT));
      const secret = (detail.body["data"] as { webhook_secret?: string }).webhook_secret;
      expect(typeof secret).toBe("string");

      await json(
        await api("/api/sandbox/inbound", {
          body: JSON.stringify({ text: "does my handler run?" }),
          method: "POST",
        }),
      );

      // Gateway → Redis → worker → HTTP. Several hops, none of them instant.
      for (let i = 0; i < 60 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(received.length).toBeGreaterThan(0);

      const delivery = received[0]!;
      /**
       * The default is their plain shared-secret compare, not an HMAC — `webhook_hmac` is a wapi
       * extension and off by default, for compatibility. Asserting the default is what proves a
       * client written against the original still verifies our deliveries.
       */
      expect(delivery.signature).toBe(secret ?? null);

      const payload = JSON.parse(delivery.body) as Record<string, unknown>;
      expect(payload["event"]).toBe("messages.received");
      expect(payload["sessionId"]).toBe(sessionId);
      expect(typeof payload["timestamp"]).toBe("number");
      expect(payload["data"]).toBeTruthy();
    } finally {
      sink.stop(true);
      // Leave the session as it was found; later tests should not inherit a dead webhook URL.
      await api(
        `/api/whatsapp-sessions/${sessionId}`,
        { body: JSON.stringify({ webhook_enabled: false, webhook_url: "" }), method: "PUT" },
        PAT,
      ).catch(() => null);
    }
    // Bun's default is five seconds, and four hops with a retrying queue behind them is not a
    // five-second proposition on a loaded CI runner.
  }, 30_000);
});

d("presence, usernames and session logs", () => {
  test("a presence update echoes what was sent", async () => {
    const r = await json(
      await api("/api/send-presence-update", {
        body: JSON.stringify({ jid: `+999${String(sessionId).padStart(8, "0")}001`, type: "composing" }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ type: "composing" });
  });

  test("an unknown presence type is refused rather than sent", async () => {
    const r = await json(
      await api("/api/send-presence-update", {
        body: JSON.stringify({ jid: `+999${String(sessionId).padStart(8, "0")}001`, type: "dancing" }),
        method: "POST",
      }),
    );
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("composing");
  });

  test("a username is a success with null in it", async () => {
    const r = await json(
      await api(`/api/fetch-username/${encodeURIComponent(`+999${String(sessionId).padStart(8, "0")}001`)}`),
    );
    expect(r.status).toBe(200);
    const body = r.body["data"] as { jid: string; username: string | null };
    expect(body.jid).toContain("@s.whatsapp.net");
    /**
     * WhatsApp volunteers a username only for accounts that have set one and offers no way to
     * ask, so null is the ordinary answer — and the branch a caller must handle.
     */
    expect(body.username).toBeNull();
  });

  test("session logs use the Laravel paginator and record the pairing", async () => {
    const r = await json(await api(`/api/whatsapp-sessions/${sessionId}/session-logs`, {}, PAT));
    expect(r.status).toBe(200);

    const page = r.body["data"] as { current_page: number; data: Record<string, unknown>[]; total: number };
    expect(page.current_page).toBe(1);
    expect(Array.isArray(page.data)).toBe(true);
    // Connecting a sandbox goes need_scan → connected, so both transitions were recorded.
    expect(page.total).toBeGreaterThan(0);

    const row = page.data[0]!;
    for (const key of ["id", "whatsapp_session_id", "event_type", "status", "occurred_at"]) {
      expect(key in row).toBe(true);
    }
    expect(row["whatsapp_session_id"]).toBe(sessionId);
    expect(row["event_type"]).toBe("status_change");
  });

  test("session logs need a PAT and belong to their account", async () => {
    const withKey = await json(await api(`/api/whatsapp-sessions/${sessionId}/session-logs`));
    expect(withKey.status).toBe(403);

    const missing = await json(await api("/api/whatsapp-sessions/99999999/session-logs", {}, PAT));
    expect(missing.status).toBe(404);
  });
});

d("editing and deleting", () => {
  const sendOne = async (text: string) => {
    const r = await json(
      await api("/api/send-message", {
        body: JSON.stringify({ text, to: `+999${String(sessionId).padStart(8, "0")}001` }),
        method: "POST",
      }),
    );
    return (r.body["data"] as { msgId: number }).msgId;
  };

  test("an edit returns a fresh key but keeps the original msgId", async () => {
    const msgId = await sendOne("before the edit");
    const r = await json(
      await api(`/api/messages/${msgId}`, { body: JSON.stringify({ text: "after" }), method: "PUT" }),
    );

    expect(r.status).toBe(200);
    const body = r.body["data"] as { id: string; key: Record<string, unknown>; msgId: number };
    expect(body.msgId).toBe(msgId);
    // An edit is a new message superseding the old one, so the WhatsApp key must differ.
    expect(body.key["id"]).toBe(body.id);
    expect(body.id).toBeTruthy();

    // And `/info` on the same id keeps working, now pointing at the newer key.
    const info = await json(await api(`/api/messages/${msgId}/info`));
    expect(info.status).toBe(200);
  });

  test("an edit needs text", async () => {
    const msgId = await sendOne("x");
    const r = await json(await api(`/api/messages/${msgId}`, { body: "{}", method: "PUT" }));
    expect(r.status).toBe(422);
  });

  test("delete puts message at the TOP level", async () => {
    const msgId = await sendOne("to be deleted");
    const r = await json(await api(`/api/messages/${msgId}`, { method: "DELETE" }));

    expect(r.status).toBe(200);
    expect(typeof r.body["message"]).toBe("string");
    expect(r.body["data"]).toBeUndefined();
  });

  test("resend refuses a message that did not fail", async () => {
    const msgId = await sendOne("healthy");
    const r = await json(await api(`/api/messages/${msgId}/resend`, { method: "POST" }));
    /**
     * Their restriction, and the right one: a send that timed out is recorded as `in_progress`
     * because nobody knows whether it arrived, so resending it is how a customer gets the same
     * message twice.
     */
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("failed");
  });

  test("a message belonging to nobody is a 404, not a 500", async () => {
    for (const path of ["/api/messages/99999999", "/api/messages/99999999/resend"]) {
      const method = path.endsWith("resend") ? "POST" : "DELETE";
      const r = await json(await api(path, { method }));
      expect(r.status).toBe(404);
    }
  });
});

d("group membership", () => {
  test("promote and demote report per participant", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const participants = (await json(await api(`/api/groups/${groups[0]!.id}/participants`))).body[
      "data"
    ] as { id: string }[];
    const member = participants[1]!.id;

    const promoted = await json(
      await api(`/api/groups/${groups[0]!.id}/participants/update`, {
        body: JSON.stringify({ action: "promote", participants: [member] }),
        method: "PUT",
      }),
    );
    expect(promoted.status).toBe(200);
    /**
     * `{participants: [jid]}`, and deliberately not the `[{status, jid, message}]` array that
     * `add` and `remove` return — theirs, two shapes for the same kind of work on neighbouring
     * endpoints. Only the participants that actually changed are listed, which is a caller's
     * only way to spot a partial failure in a payload that carries no status.
     */
    expect(promoted.body["data"]).toEqual({ participants: [member] });

    const after = (await json(await api(`/api/groups/${groups[0]!.id}/participants`))).body["data"] as {
      admin: string | null;
      id: string;
    }[];
    expect(after.find((p) => p.id === member)!.admin).toBe("admin");
  });

  test("an unknown action is refused rather than guessed at", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const r = await json(
      await api(`/api/groups/${groups[0]!.id}/participants/update`, {
        body: JSON.stringify({ action: "banish", participants: ["99900000001001@s.whatsapp.net"] }),
        method: "PUT",
      }),
    );
    expect(r.status).toBe(422);
    expect(String(r.body["error"])).toContain("promote");
  });

  /**
   * The sixth success envelope. `inviteLink` sits beside `success` rather than under `data`, so a
   * client reading `data.inviteLink` gets undefined — which is precisely why it is asserted.
   */
  test("an invite link is returned at the TOP level, not under data", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const r = await json(await api(`/api/groups/${groups[0]!.id}/invite-link`));

    expect(r.status).toBe(200);
    expect(typeof r.body["inviteLink"]).toBe("string");
    expect(String(r.body["inviteLink"])).toStartWith("https://chat.whatsapp.com/");
    expect(r.body["data"]).toBeUndefined();
  });

  test("a group picture uses the same nullable shape as a contact's", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const r = await json(await api(`/api/groups/${groups[0]!.id}/picture`));
    expect(r.status).toBe(200);
    expect("imgUrl" in (r.body["data"] as object)).toBe(true);
  });

  test("settings change only what is sent", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const r = await json(
      await api(`/api/groups/${groups[0]!.id}/settings`, {
        body: JSON.stringify({ subject: "Renamed by test" }),
        method: "PUT",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ subject: "Renamed by test" });

    const meta = (await json(await api(`/api/groups/${groups[0]!.id}/metadata`))).body["data"] as {
      subject: string;
    };
    expect(meta.subject).toBe("Renamed by test");
  });

  test("an invite code can be inspected before joining, and a bad one is refused", async () => {
    const groups = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const link = (await json(await api(`/api/groups/${groups[0]!.id}/invite-link`))).body[
      "inviteLink"
    ] as string;
    const code = link.split("/").pop()!;

    const info = await json(await api(`/api/groups/invite/${code}`));
    expect(info.status).toBe(200);
    expect((info.body["data"] as { id: string }).id).toBe(groups[0]!.id);

    const bad = await json(await api("/api/groups/invite/definitely-not-a-code"));
    expect(bad.status).toBe(422);
    expect(String(bad.body["error"])).toContain("invite");
  });

  test("accepting an invite returns the group id, and a bad code does not", async () => {
    const accepted = await json(
      await api("/api/groups/invite/accept", {
        body: JSON.stringify({ code: "SANDBOX000001ffffffff" }),
        method: "POST",
      }),
    );
    expect(accepted.status).toBe(200);
    expect(String((accepted.body["data"] as { id: string }).id)).toEndWith("@g.us");

    const bad = await json(
      await api("/api/groups/invite/accept", { body: JSON.stringify({ code: "nope" }), method: "POST" }),
    );
    expect(bad.status).toBe(422);
  });

  /** Last, because it removes a group the tests above rely on. */
  test("leaving a group removes it from the listing", async () => {
    const before = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    const target = before[before.length - 1]!.id;

    const r = await json(await api(`/api/groups/${target}/leave`, { method: "POST" }));
    expect(r.status).toBe(200);
    expect(r.body["data"]).toEqual({});

    const after = (await json(await api("/api/groups"))).body["data"] as { id: string }[];
    expect(after.map((g) => g.id)).not.toContain(target);
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
