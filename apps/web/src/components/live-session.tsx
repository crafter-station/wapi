"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { StatusBadge } from "./status-badge";

/**
 * Live pairing panel.
 *
 * Subscribes to the session's SSE stream so the QR appears the moment the gateway emits it,
 * and the status flips to `connected` without a refresh. WhatsApp rotates the QR roughly
 * every twenty seconds, so a few redraws before a scan lands are expected.
 */
export function LiveSession({ id, initialStatus }: { id: number; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [qr, setQr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/sessions/${id}/events`);
    es.addEventListener("open", () => setLive(true));
    es.addEventListener("status", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { status: string };
      setStatus(d.status);
      if (d.status === "connected") setQr(null);
    });
    es.addEventListener("qr", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { qr: string };
      setQr(d.qr);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [id]);

  useEffect(() => {
    if (!qr || !canvas.current) return;
    // Rendered client-side: the QR string is short-lived and there is no reason to round-trip
    // an image through the server for it.
    void QRCode.toCanvas(canvas.current, qr, { width: 256, margin: 1 });
  }, [qr]);

  return (
    <div className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Connection</p>
        <span className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span
            title={live ? "live updates connected" : "live updates offline"}
            className="font-mono text-[10px] text-[var(--muted-foreground)]"
          >
            {live ? "SSE" : "—"}
          </span>
        </span>
      </div>

      {qr ? (
        <div className="space-y-2">
          <canvas ref={canvas} className="rounded-[var(--radius)] bg-white p-2" />
          <p className="text-xs text-[var(--muted-foreground)]">
            WhatsApp → Settings → Linked devices → Link a device. The code refreshes about
            every 20 seconds.
          </p>
        </div>
      ) : status === "connected" ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          Linked and online. This survives redeploys — the gateway reconnects from stored
          credentials.
        </p>
      ) : (
        <p className="text-sm text-[var(--muted-foreground)]">
          Press Connect to start linking. A QR will appear here.
        </p>
      )}
    </div>
  );
}
