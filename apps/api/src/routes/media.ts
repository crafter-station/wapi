import { Hono } from "hono";
import type { Db } from "@wapi/db";
import { fail } from "@wapi/contracts";
import { storage, MAX_UPLOAD_BYTES } from "@wapi/core";
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
      const { url } = await store.put({ name, data, contentType: mimetype });
      return c.json({ success: true, publicUrl: url });
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
      // One hour, as documented.
      const publicUrl = await store.signedUrl(key, 3600);
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

function extFor(mimetype: string): string {
  const sub = mimetype.split("/")[1] ?? "bin";
  return sub.split(";")[0]!.replace("jpeg", "jpg").replace("mpeg", "mp3");
}
