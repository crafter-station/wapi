import { createClient } from "redis";
import { getSession } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live session events over SSE.
 *
 * PLAN.md §2 chose Redis pub/sub for the outbound direction precisely because events fan out
 * to more than one consumer: `qrcode.updated` has to reach this stream *and* the webhook
 * queue at the same time. Polling the QR endpoint was named as the fallback, not the design.
 *
 * The subscription is filtered to one session, and access is checked through `getSession`,
 * which is scoped to the signed-in Clerk account — so a user cannot stream someone else's QR.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  const session = await getSession(sessionId);
  if (!session) return new Response("not found", { status: 404 });

  const url = process.env["REDIS_URL"];
  if (!url) return new Response("redis not configured", { status: 503 });

  const encoder = new TextEncoder();
  const sub = createClient({ url });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      await sub.connect();
      await sub.subscribe("wapi:events", (raw) => {
        try {
          const e = JSON.parse(raw) as { type: string; sessionId: number; qr?: string; status?: string };
          if (e.sessionId !== sessionId) return;
          if (e.type === "qr" && e.qr) send("qr", { qr: e.qr });
          if (e.type === "status" && e.status) send("status", { status: e.status });
        } catch {
          /* a malformed message must not kill the stream */
        }
      });

      send("open", { sessionId, status: session.status });

      // Comment frames keep proxies from timing the connection out.
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any)._cleanup = () => {
        clearInterval(ping);
        void sub.quit().catch(() => {});
      };
    },
    cancel(reason) {
      void sub.quit().catch(() => {});
      void reason;
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
