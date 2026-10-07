"use client";

import { useState } from "react";

/**
 * Where the rendered film lives.
 *
 * A release asset rather than a file in this repo: it is regenerated on every cut, and a few
 * megabytes per version would be permanent weight in each future clone. The same
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
        {/*
          Ordered by measured bytes, and mp4 is currently the smaller one.
          
          A browser takes the FIRST source it can play, so this order decides what everybody
          downloads. The webm was listed first on the strength of a number written into a comment
          back when the film was 1120x630 — at 2560x1440 the vp9 encode overtook h264 and nobody
          re-derived the order, so every play fetched 9.0 MB instead of 4.9 MB. Measure the release
          assets before changing this (`gh release view --json assets`); do not trust the shape of
          the usual answer, and do not write the sizes here, because a number in a comment goes
          stale and then quietly decides things.
        */}
        <source src={MP4} type="video/mp4" />
        <source src={WEBM} type="video/webm" />
      </video>
    );
  }

  return (
    <button
      aria-label="Play the demo — 78 seconds"
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
        78 seconds
      </span>
    </button>
  );
}
