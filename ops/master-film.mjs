/**
 * Bring the rendered film up to a normal listening level.
 *
 * Remotion mixes the music bed and the effects at the levels the composition asks for, and those
 * levels are chosen for *balance* — the bed under the clicks, the clicks under the payoff. Balance
 * says nothing about absolute loudness, and the first render with music came out at **-26.1 LUFS**:
 * correct internally, and about 10 dB below what web video is mastered to, so every viewer would
 * have reached for the volume.
 *
 * Fixing that by rebalancing was the wrong tool. The effects were already close to their ceiling —
 * Remotion's `volume` does not usefully exceed 1 — so the only lever left was the music, and
 * raising just the music would have destroyed the balance to fix the level. One pass at the end
 * moves everything together and leaves the mix exactly as composed.
 *
 * The video stream is **copied, not re-encoded**: this touches audio only, so the picture is
 * bit-identical to what Remotion produced and costs seconds rather than minutes.
 *
 *   node ops/master-film.mjs apps/video/out/wapi-demo.mp4
 *
 * -16 LUFS with a -1.5 dBTP ceiling: the usual target for web video, and quiet enough that a
 * restrained film does not arrive shouting.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync } from "node:fs";

const TARGET_I = -16;
const TARGET_TP = -1.5;

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("usage: node ops/master-film.mjs <rendered file>");
  process.exit(2);
}

/** Audio codec has to match the container: mp4 takes AAC, webm takes Opus. */
const codec = file.endsWith(".webm") ? "libopus" : "aac";
const temp = file.replace(/\.(mp4|webm)$/, ".mastered.$1");

const before = spawnSync(
  "ffmpeg",
  ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=summary", "-f", "null", "-"],
  { encoding: "utf8" },
);
const measured = /Input Integrated:\s+(-?[\d.]+) LUFS/.exec(before.stderr ?? "")?.[1];

const res = spawnSync(
  "ffmpeg",
  [
    "-y", "-i", file,
    "-c:v", "copy",
    "-c:a", codec,
    "-b:a", "160k",
    "-af", `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=11`,
    temp,
  ],
  { encoding: "utf8" },
);

if (res.status !== 0) {
  console.error(res.stderr?.slice(-800) ?? "ffmpeg failed");
  if (existsSync(temp)) unlinkSync(temp);
  process.exit(1);
}

unlinkSync(file);
renameSync(temp, file);

const after = spawnSync(
  "ffmpeg",
  ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=summary", "-f", "null", "-"],
  { encoding: "utf8" },
);
const now = /Input Integrated:\s+(-?[\d.]+) LUFS/.exec(after.stderr ?? "")?.[1];

console.log(`  ${file}: ${measured ?? "?"} LUFS -> ${now ?? "?"} LUFS`);
