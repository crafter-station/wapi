import { Hono } from "hono";
import type { Db } from "@wapi/db";
import { fail } from "@wapi/contracts";
import { storage, MAX_UPLOAD_BYTES, signMediaLink, verifyMediaLink } from "@wapi/core";
import { gateway, GatewayUnavailableError, SessionNotConnectedError } from "../gateway-client.ts";

/**
 * Media — the last two Tier-1 routes.
 *
 * Both return `publicUrl` at the **top level**, not under `data`. That is a fifth distinct
 * success envelope in this API, alongside data-wrapped, `api_key` at top level, `message` at
 * top level, and the bare `{status}` of GET /api/status (PLAN.md §1.4).
 */
export function mediaRoutes(_db: Db) {
  const app = new Hono();

  /**
   * POST /api/upload.
   *
   * Two documented request forms: a raw binary body, or JSON `{base64, mimetype}`. Both cap
   * at 16 MB. Content-Length is checked first so an oversized body is refused before it is
   * buffered — a 20 MB upload should not cost 20 MB of heap to reject.
   */
  app.post("/upload", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const declared = Number(c.req.header("Content-Length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES * 1.4) {
      return c.json(fail("File size exceeds the limit of 16 MB for this file type."), 413);
    }

    let data: Buffer;
    let mimetype: string;
    let name: string;

    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await c.req.json().catch(() => ({}))) as {
        base64?: string;
        mimetype?: string;
        fileName?: string;
      };
      if (!body.base64) return c.json(fail("The base64 field is required for JSON uploads."), 422);
      data = Buffer.from(body.base64, "base64");
      mimetype = body.mimetype ?? "application/octet-stream";
      name = body.fileName ?? `upload.${extFor(mimetype)}`;
    } else {
      data = Buffer.from(await c.req.arrayBuffer());
      mimetype = contentType || "application/octet-stream";
      name = `upload.${extFor(mimetype)}`;
    }

    if (!data.length) return c.json(fail("The request body is empty."), 422);
    if (data.length > MAX_UPLOAD_BYTES) {
      return c.json(fail("File size exceeds the limit of 16 MB for this file type."), 413);
    }

    try {
      const store = await storage();
      const { key } = await store.put({ name, data, contentType: mimetype });
      /**
       * A PERMANENT url, not the presigned one the storage driver hands back.
       *
       * Their documented upload returns a stable link (`.../media/<uuid>.jpg`); only
       * decrypt-media is time-limited. The difference is not cosmetic: callers upload media
       * and pass the URL to send-message later, and Baileys fetches it server-side at send
       * time — an hour-long presigned link would simply stop working.
       */
      return c.json({ success: true, publicUrl: `${publicBase(c)}/media/${key}` });
    } catch (err) {
      console.error({ err: String(err) }, "upload failed");
      return c.json(fail("The upload service is temporarily unavailable. Please retry."), 503);
    }
  });

  /**
   * POST /api/decrypt-media.
   *
   * Takes a raw Baileys media node — `url`, `mediaKey`, `fileSha256`, `mimetype` — because
   * WhatsApp hands out an *encrypted* CDN blob and only the session holding the keys can
   * decrypt it. This endpoint is precisely why the original had to be Baileys: the Cloud API
   * never exposes these fields (see TECH-STACK.md).
   *
   * The returned URL is valid for one hour, matching their documented behaviour.
   */
  app.post("/decrypt-media", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "session") return c.json(fail("This endpoint requires a session API key."), 403);

    const body = (await c.req.json().catch(() => ({}))) as {
      data?: { messages?: { message?: Record<string, unknown>; key?: Record<string, unknown> } };
    };
    const message = body.data?.messages?.message;
    /**
     * Check for a media node here rather than after a gateway round-trip.
     *
     * Their documented error for this case is specific, and answering it locally means a
     * malformed request gets the right message even when the gateway is down — otherwise a
     * validation failure masquerades as a 503.
     */
    const MEDIA_FIELDS = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "documentMessage",
      "stickerMessage",
    ];
    const hasMedia =
      message && typeof message === "object" && MEDIA_FIELDS.some((f) => f in message);
    if (!hasMedia) {
      return c.json(fail("No supported media object (image, video, etc.) found in the message."), 422);
    }

    try {
      const { media } = await gateway.downloadMedia(auth.sessionId, message);
      if (!media) {
        return c.json(
          fail("No supported media object (image, video, etc.) found in the message."),
          422,
        );
      }

      const store = await storage();
      const { key } = await store.put({
        name: media.fileName,
        data: Buffer.from(media.base64, "base64"),
        contentType: media.mimetype,
      });
      /**
       * One hour, as documented — but on OUR origin, not the object store's.
       *
       * This used to hand back the store's presigned URL. It expires correctly, but its
       * hostname is `uploadx.crafter.run` rather than ours, and a strict client pins the media
       * host to the provider host it was configured with. Such a client rejects the link before
       * reading a byte, so a faithful media surface has to be served from the API's own domain.
       * The expiry therefore moves into a signature we mint and `/media/*` enforces.
       */
      const { expires, sig } = signMediaLink(key, 3600);
      const publicUrl = `${publicBase(c)}/media/${key}?expires=${expires}&sig=${sig}`;
      return c.json({ success: true, publicUrl });
    } catch (err) {
      if (err instanceof SessionNotConnectedError) return c.json(fail(err.message), 409);
      if (err instanceof GatewayUnavailableError) {
        return c.json(fail("The WhatsApp service is temporarily unavailable. Please retry."), 503);
      }
      console.error({ err: String(err) }, "decrypt-media failed");
      return c.json(fail("The media could not be decrypted."), 500);
    }
  });

  return app;
}

/**
 * Root-level media serving, mounted at `/` rather than `/api`.
 *
 * Their public media links are `wasenderapi.com/media/<uuid>.jpg` — no `/api` prefix — so this
 * is a separate router to match. Unauthenticated by design: it is the link `upload` hands out.
 * `decrypt-media`'s link is the same path carrying an expiring signature, verified below.
 */
export function mediaServeRoutes() {
  const app = new Hono();
  /**
   * Serve stored media under a stable path.
   *
   * Redirects to a short-lived signed URL rather than proxying the bytes, so the object store
   * does the transfer and this process stays stateless. The *outer* URL never expires, which
   * is what makes it usable as a `send-message` input.
   *
   * Outside the 29-route surface by necessity — their API has an equivalent `/media/...` path,
   * so this mirrors the original rather than inventing something.
   */
  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    if (!key) return c.json(fail("Not found."), 404);

    /**
     * Two kinds of link arrive here.
     *
     * `upload` hands out a permanent one with no query — that is what makes it usable as a
     * later `send-message` input. `decrypt-media` hands out a signed one that expires after an
     * hour. Presence of the signature is what distinguishes them, and a signature that is
     * present must verify: an expired or forged one is a 404, not a redirect.
     */
    const expires = c.req.query("expires");
    const sig = c.req.query("sig");
    if (expires !== undefined || sig !== undefined) {
      if (!expires || !sig || !verifyMediaLink(key, expires, sig)) {
        return c.json(fail("Not found."), 404);
      }
    }

    try {
      const store = await storage();
      const signed = await store.signedUrl(decodeURIComponent(key), 300);
      /**
       * Stream the bytes rather than 302-ing to the store.
       *
       * A redirect is cheaper and was the original implementation here, but it moves the
       * download to another hostname, and clients that pin the media host re-validate it on
       * every hop — so the redirect is refused and the media is unreachable. Proxying keeps
       * the whole exchange on one origin. Objects are capped at 16 MB, so the cost is bounded,
       * and the body is piped rather than buffered.
       */
      const upstream = await fetch(signed);
      if (!upstream.ok || !upstream.body) return c.json(fail("Not found."), 404);
      const headers = new Headers();
      for (const h of ["content-type", "content-length", "etag", "last-modified"]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      // A permanent link is immutable; a signed one must not outlive its signature in a cache.
      headers.set("cache-control", sig ? "private, max-age=60" : "public, max-age=31536000, immutable");
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      return c.json(fail("Not found."), 404);
    }
  });

  return app;
}

/** Public origin for building absolute media URLs. */
function publicBase(c: { req: { url: string } }): string {
  return process.env["PUBLIC_URL"] ?? new URL(c.req.url).origin;
}

function extFor(mimetype: string): string {
  const sub = mimetype.split("/")[1] ?? "bin";
  return sub.split(";")[0]!.replace("jpeg", "jpg").replace("mpeg", "mp3");
}
