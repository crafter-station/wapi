/**
 * Cut the film's music bed from the delivered track.
 *
 * The source is a ~2:20 instrumental generated in Suno (Pro tier, so the commercial rights come
 * with the download — see the licence note below). It is **not committed**: 27 MB of PCM in git,
 * for something regenerated rather than authored, is the same trade this repo already declined for
 * the rendered film. What is committed is the 1.9 MB excerpt this produces, plus this script, so
 * the transformation is reproducible rather than folklore.
 *
 *   node ops/make-music.mjs path/to/background.wav
 *
 * **Why it starts at 4 seconds.** The track opens with five seconds of silence and runs to a real
 * ending at 2:17, and 78 seconds have to come from somewhere. Two candidates: the last 78s, which
 * would land the track's genuine ending on the end card; or the first 78s from where it begins.
 * Mapping the track's level second by second decided it — there is a breakdown at 1:12 and another
 * at 1:36. Taking the tail put the first of those on the film's opening send, which is the beat
 * that most needs presence. Starting at 0:04 puts it at 1:08 instead, on the payoff title, where
 * the film wants to thin out anyway. The cost is a manufactured fade rather than the track's own
 * ending, spent across the end card where it reads as intended.
 *
 * **-26 LUFS** because it is a bed, not the subject. The effects peak around -20 dBFS, so the
 * music has to sit under them or the key clicks vanish. Normalising here rather than with a
 * `volume` prop keeps the decision in one place: the composition plays this file at unity.
 *
 * Needs ffmpeg on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const SOURCE = process.argv[2];
const OUT = "apps/video/public/music";
const TARGET = `${OUT}/bed.mp3`;

/** Exactly the composition's length, so the bed neither loops nor runs out early. */
const DURATION = 78.06;
const START = 4;

if (!SOURCE) {
  console.error("usage: node ops/make-music.mjs path/to/background.wav");
  process.exit(2);
}
if (!existsSync(SOURCE)) {
  console.error(`${SOURCE} does not exist.`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const res = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-ss", String(START),
    "-t", String(DURATION),
    "-i", SOURCE,
    "-af",
    // In over the landing scroll, out across the end card, then levelled.
    "afade=t=in:st=0:d=2.5,afade=t=out:st=74:d=4,loudnorm=I=-26:TP=-6:LRA=11",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    TARGET,
  ],
  { encoding: "utf8" },
);

if (res.status !== 0) {
  console.error(res.stderr?.slice(-800) ?? "ffmpeg failed");
  process.exit(1);
}

console.log(`ok — wrote ${TARGET}`);
