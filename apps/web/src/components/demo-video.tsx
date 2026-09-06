"use client";

import { useState } from "react";

/**
 * Where the rendered film lives.
 *
 * A release asset rather than a file in this repo. The mp4 is ~4.2 MB (webm ~2.7 MB, and it is
 * listed first so most browsers take it) and gets re-rendered every time the cut changes, while
 * `apps/web/public` is otherwise 48 KB — putting it in git would be permanent weight in every
 * future clone for something that is regenerated, not authored. The same
 * `releases/latest/download` mechanism already serves the CLI binaries.
 *
 * Overridable so a deployment can serve it from its own origin instead.
 */
const MP4 =
  process.env["NEXT_PUBLIC_DEMO_VIDEO_URL"] ??
  "https://github.com/crafter-station/wapi/releases/latest/download/wapi-demo.mp4";
const WEBM =
  process.env["NEXT_PUBLIC_DEMO_VIDEO_WEBM_URL"] ??
  "https://github.com/crafter-station/wapi/releases/latest/download/wapi-demo.webm";

/**
 * The demo, behind a poster.
 *
 * **Click to play, not autoplay**, and that decision does real work. The film has a soundtrack, and
 * a browser will only autoplay muted — so an autoplaying loop would show the whole thing to
 * somebody who never hears it and burn the payoff. Requiring a click means every view is a chosen
 * one.
 *
 * It also settles `prefers-reduced-motion` for free, which this site has no other handling for: a
 * poster is a still image until somebody asks for motion.
 *
 * The poster is committed; the video is fetched on demand. Nothing loads until the click, so the
 * page costs 40 KB rather than 1.2 MB for readers who never press play.
 */
export function DemoVideo({ className }: { className?: string }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        autoPlay
        className={className}
        controls
        poster="/demo-poster.jpg"
        style={{
          aspectRatio: "1120 / 630",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          display: "block",
          width: "100%",
        }}
      >
        <source src={WEBM} type="video/webm" />
        <source src={MP4} type="video/mp4" />
      </video>
    );
  }

  return (
    <button
      aria-label="Play the demo — 74 seconds"
      className={className}
      onClick={() => setPlaying(true)}
      style={{
        aspectRatio: "1120 / 630",
        background: `center / cover no-repeat url(/demo-poster.jpg)`,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        cursor: "pointer",
        display: "block",
        padding: 0,
        position: "relative",
        width: "100%",
      }}
      type="button"
    >
      <span
        style={{
          alignItems: "center",
          background: "var(--foreground)",
          borderRadius: 999,
          color: "var(--background)",
          display: "flex",
          height: 62,
          insetInlineStart: "50%",
          justifyContent: "center",
          position: "absolute",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 62,
        }}
      >
        {/* A triangle, not an icon font: one glyph that cannot fail to load. */}
        <span style={{ fontSize: 20, marginInlineStart: 4 }}>▶</span>
      </span>
      <span
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          bottom: 12,
          color: "var(--muted-foreground)",
          fontSize: "0.75rem",
          insetInlineEnd: 12,
          padding: "4px 10px",
          position: "absolute",
        }}
      >
        74 seconds
      </span>
    </button>
  );
}
