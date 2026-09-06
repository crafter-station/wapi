import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { font, theme } from "../theme";

export type ThreadMessage = {
  at: string;
  file_name: string | null;
  from_me: boolean;
  id: string;
  jid: string;
  kind: string;
  media_url: string | null;
  text: string | null;
};

/**
 * Local stand-ins for the captured media URLs.
 *
 * The transcript records production URLs, which is correct — that is where the files really went.
 * But a render that fetches four remote files is a render that fails on a flaky network and
 * produces a different frame depending on the day, so the film plays the same bytes from
 * `public/assets`. The mapping is by filename, so it breaks loudly if an asset is renamed rather
 * than silently rendering a blank bubble.
 */
const LOCAL: Record<string, string> = {
  "photo.png": "assets/photo.png",
  "sticker.webp": "assets/sticker.webp",
  "clip.mp4": "assets/clip.mp4",
  "invoice.pdf": "assets/invoice.pdf",
};

const localFor = (url: string | null): string | null => {
  if (!url) return null;
  const name = url.split("/").pop() ?? "";
  const path = LOCAL[name];
  return path ? staticFile(path) : null;
};

/**
 * One bubble, matching the dashboard's.
 *
 * The same shapes as `apps/web/src/app/sessions/[id]/sandbox/page.tsx`: sent messages are solid
 * foreground, received ones are a bordered wash. Rebuilt rather than screenshotted because they
 * have to arrive one at a time — a screenshot cannot animate — but the *content* is the captured
 * thread, so nothing here is invented.
 */
const Bubble: React.FC<{ index: number; message: ThreadMessage; startAt: number }> = ({
  index,
  message,
  startAt,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Springs in from below, like a message landing rather than a card fading up.
  const enter = spring({ config: { damping: 200 }, durationInFrames: 18, fps, frame: frame - startAt });
  const local = localFor(message.media_url);

  const body = (() => {
    if (local && message.kind === "image") {
      return <Img src={local} style={{ borderRadius: 6, display: "block", maxWidth: 200 }} />;
    }
    if (local && message.kind === "sticker") {
      // Smaller and unframed. A sticker is not a photo and sizing it like one reads wrong.
      return <Img src={local} style={{ display: "block", height: 96, objectFit: "contain", width: 96 }} />;
    }
    if (local && message.kind === "video") {
      // A poster frame rather than playback: the bubble is on screen for under a second, and a
      // video element that has not buffered renders black.
      return (
        <div
          style={{
            alignItems: "center",
            background: theme.muted,
            borderRadius: 6,
            display: "flex",
            height: 112,
            justifyContent: "center",
            width: 200,
          }}
        >
          <span style={{ color: theme.foreground, fontSize: 22 }}>▶</span>
        </div>
      );
    }
    if (message.kind === "document") {
      return (
        <span style={{ display: "flex", gap: 6 }}>
          <span>▤</span>
          <span>{message.file_name ?? "invoice.pdf"}</span>
        </span>
      );
    }
    return null;
  })();

  return (
    <div
      style={{
        display: "flex",
        justifyContent: message.from_me ? "flex-end" : "flex-start",
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [14, 0])}px)`,
      }}
    >
      <div
        style={{
          background: message.from_me ? theme.foreground : theme.muted,
          border: message.from_me ? "none" : `1px solid ${theme.border}`,
          borderRadius: 12,
          color: message.from_me ? theme.background : theme.foreground,
          fontSize: 13,
          lineHeight: 1.5,
          maxWidth: "78%",
          padding: "8px 11px",
        }}
      >
        {body}
        {message.text ? <div style={{ marginTop: body ? 6 : 0 }}>{message.text}</div> : null}
      </div>
    </div>
  );
};

/**
 * The phone.
 *
 * A bezel, because it makes "this is WhatsApp" legible in half a second and the film moves fast.
 * The header says **Sandbox** rather than a person's name: implying this is somebody's real chat
 * would be a lie, and the whole point is that nobody real is involved.
 */
export const Phone: React.FC<{
  messages: ThreadMessage[];
  /** Frame at which the first bubble lands; each subsequent one follows by `stagger`. */
  startAt?: number;
  stagger?: number;
  title?: string;
}> = ({ messages, startAt = 0, stagger = 14, title = "Sandbox" }) => (
  <div
    style={{
      background: "#0a0a0a",
      borderRadius: 34,
      boxShadow: "0 30px 80px rgba(10,10,10,0.22)",
      height: 520,
      padding: 9,
      width: 262,
    }}
  >
    <div
      style={{
        background: theme.background,
        borderRadius: 27,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          fontFamily: font.sans,
          gap: 8,
          padding: "14px 14px 10px",
        }}
      >
        <div style={{ background: theme.muted, borderRadius: 999, height: 26, width: 26 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 580 }}>{title}</div>
          <div style={{ color: theme.mutedForeground, fontSize: 10 }}>+999 · not a real number</div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          fontFamily: font.sans,
          gap: 7,
          // Bottom-aligned, so a thread grows upward the way a chat does.
          justifyContent: "flex-end",
          /*
           * `minHeight: 0` is what makes the clipping work.
           *
           * A `flex: 1` column defaults to `min-height: auto`, so it refuses to shrink below its
           * content and the overflow escapes *downwards* — through the phone's bottom bezel, which
           * is exactly what it looked like: a video bubble sliced in half by the chassis. With
           * this, a thread longer than the screen scrolls the oldest messages off the top, which is
           * what a real chat does.
           */
          minHeight: 0,
          overflow: "hidden",
          padding: "12px 11px 16px",
        }}
      >
        {messages.map((m, i) => (
          <Bubble index={i} key={m.id} message={m} startAt={startAt + i * stagger} />
        ))}
      </div>
    </div>
  </div>
);
