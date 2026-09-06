/**
 * Master the film's audio and mux it onto the rendered picture.
 *
 * Replaces an earlier script that mastered the finished mp4 in place, which sounded wrong and
 * deserved to. That version took Remotion's already-encoded AAC — written at **96 kHz**, which is
 * an odd rate for delivery — decoded it, applied about 10 dB of gain, and encoded it to AAC again.
 * Two lossy generations with a large gain between them amplifies every artifact the first encode
 * introduced, and single-pass `loudnorm` is a dynamic filter, so it pumps as well.
 *
 * The fix is to stop encoding audio twice. Remotion will render the mix straight to 48 kHz PCM, so
 * this takes that, measures it, normalises it **linearly** in a second pass, and encodes once onto
 * a video stream that is copied rather than re-encoded.
 *
 *   node ops/mux-film.mjs apps/video/out/video.mp4 apps/video/out/audio.wav apps/video/out/wapi-demo.mp4
 *
 * -16 LUFS with a -1.5 dBTP ceiling: the usual target for web video, and quiet enough that a
 * restrained film does not arrive shouting.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TARGET_I = -16;
const TARGET_TP = -1.5;
const TARGET_LRA = 11;

const [video, audio, out] = process.argv.slice(2);
if (!video || !audio || !out) {
  console.error("usage: node ops/mux-film.mjs <video> <audio.wav> <output>");
  process.exit(2);
}
for (const f of [video, audio]) {
  if (!existsSync(f)) {
    console.error(`${f} does not exist — render it first.`);
    process.exit(2);
  }
}

/** Run ffmpeg, and say something useful when it is not there. */
const ffmpeg = (args) => {
  const res = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (res.error) {
    const why =
      res.error.code === "ENOENT" ? "ffmpeg is not installed or not on PATH" : res.error.message;
    console.error(`  cannot run ffmpeg — ${why}`);
    process.exit(1);
  }
  return res;
};

/*
 * Pass one: measure.
 *
 * Two-pass rather than one is the difference between levelling the track and riding it. Single-pass
 * loudnorm adapts as it goes, which on a quiet bed under sharp transients means audibly pumping the
 * music every time a key clicks. With measured values fed back in, `linear=true` applies one
 * constant gain to the whole file and changes nothing else.
 */
const probe = ffmpeg([
  "-hide_banner", "-nostats",
  "-i", audio,
  "-af", `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
  "-f", "null", "-",
]);

const json = /\{[\s\S]*\}/.exec(probe.stderr ?? "")?.[0];
if (!json) {
  console.error("could not measure loudness:\n" + (probe.stderr ?? "").slice(-600));
  process.exit(1);
}
const m = JSON.parse(json);
console.log(`  measured: ${m.input_i} LUFS, peak ${m.input_tp} dBTP`);

const codec = out.endsWith(".webm") ? "libopus" : "aac";

// Pass two: apply, and mux onto the untouched picture.
const res = ffmpeg([
  "-y",
  "-i", video,
  "-i", audio,
  "-map", "0:v:0",
  "-map", "1:a:0",
  "-c:v", "copy",
  "-af",
  `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`,
  "-c:a", codec,
  "-b:a", "192k",
  // 48 kHz, explicitly. Remotion wrote the muxed file's audio at 96 kHz, which is not a delivery
  // rate and is resampled by every player that touches it.
  "-ar", "48000",
  "-ac", "2",
  "-movflags", "+faststart",
  "-shortest",
  out,
]);

if (res.status !== 0) {
  console.error(res.stderr?.slice(-900) ?? "ffmpeg failed");
  process.exit(1);
}

const after = ffmpeg([
  "-hide_banner", "-nostats", "-i", out,
  "-af", "loudnorm=print_format=summary", "-f", "null", "-",
]);
const now = /Input Integrated:\s+(-?[\d.]+) LUFS/.exec(after.stderr ?? "")?.[1];
console.log(`  ${out}: ${m.input_i} LUFS -> ${now ?? "?"} LUFS, one encode at 48 kHz`);
