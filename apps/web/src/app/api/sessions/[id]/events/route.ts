import { createClient } from "redis";
import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live session events over SSE.
 *
 * PLAN.md §2 chose Redis pub/sub for the outbound direction because events fan out to more
 * than one consumer: `qrcode.updated` has to reach this stream *and* the webhook queue at the
 * same time. Polling the QR endpoint was named as the fallback, not the design.
 *
 * Access is checked through `getSession`, which is scoped to the signed-in Clerk account, so
 * a user cannot stream someone else's QR.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  const session = await getSession(sessionId);
  if (!session) return new Response("not found", { status: 404 });

  const url = process.env["REDIS_URL"];
  if (!url) return new Response("redis not configured", { status: 503 });

  const encoder = new TextEncoder();
  const sub = createClient({ url });

  /**
   * Teardown state lives here, in the closure, not on the controller.
   *
   * The previous version stashed a cleanup function on the controller object and nothing ever
   * invoked it, so the keep-alive interval outlived the stream and kept calling `enqueue` on
   * a closed controller. That threw `ERR_INVALID_STATE` as an *uncaught* exception on every
   * tick, repeatedly, for every disconnected client. Closing a browser tab was enough to
   * start it.
   */
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    void sub.quit().catch(() => {});
  };

  // A client that goes away mid-stream must tear the subscription down too.
  req.signal.addEventListener("abort", teardown);

  const stream = new ReadableStream({
    async start(controller) {
      /** Every write is guarded: after close, writing is a no-op rather than a throw. */
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        await sub.connect();

        /**
         * Two channels, one stream.
         *
         * `wapi:events` carries what WhatsApp did — QR rotations, status changes, and the raw
         * engine events behind `type: "wa"`. `wapi:dispatches` carries what the webhook worker
         * did about them. Both are fanned out to every subscriber, so the sessionId filter
         * here is what keeps one account's traffic out of another's stream.
         */
        await sub.subscribe("wapi:events", (raw) => {
          try {
            const e = JSON.parse(raw) as {
              type: string;
              sessionId: number;
              qr?: string;
              status?: string;
              event?: string;
              payload?: unknown;
            };
            if (e.sessionId !== sessionId) return;
            if (e.type === "qr" && e.qr) send("qr", { qr: e.qr });
            if (e.type === "status" && e.status) send("status", { status: e.status });
            // Raw engine events, so a message list can update as traffic arrives.
            if (e.type === "wa" && e.event) send("wa", { event: e.event, payload: e.payload });
          } catch {
            /* a malformed message must not kill the stream */
          }
        });

        await sub.subscribe("wapi:dispatches", (raw) => {
          try {
            const e = JSON.parse(raw) as { sessionId: number; type: string };
            if (e.sessionId !== sessionId) return;
            if (e.type === "dispatch") send("dispatch", e);
          } catch {
            /* as above */
          }
        });
      } catch {
        teardown();
        controller.close();
        return;
      }

      send("open", { sessionId, status: session.status });

      // Comment frames keep proxies from timing the connection out.
      ping = setInterval(() => write(": ping\n\n"), 25_000);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Traefik and any intermediate proxy must not buffer an event stream.
      "X-Accel-Buffering": "no",
    },
  });
}
