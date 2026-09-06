/**
 * The film's sound effects, synthesised rather than sourced.
 *
 * Every one of these is generated from ffmpeg primitives — sine tones, pink noise, envelopes — so
 * there is no third-party licence to track, nothing to attribute, and no asset that can rot. They
 * are also tiny: the whole set is a few kilobytes, against megabytes for downloaded one-shots.
 *
 * They are deliberately *dull* — the film's palette has no brand colour and its motion has no
 * flourish, so a sound that announced itself would be the loudest thing in a restrained piece. A
 * key click should read as texture, not as a cue.
 *
 * But they are written at close to full scale, and the quietness lives in the composition instead.
 * Attenuating here as well made the final level the product of two numbers in two files, and the
 * mix silently ended up around -40 dBFS — inaudible under any music bed. One place governs
 * loudness now: the `volume` props in `Terminal.tsx`, `Phone.tsx` and `Demo.tsx`.
 *
 *   node ops/make-sfx.mjs
 *
 * Needs ffmpeg on PATH. Writes to apps/video/public/sfx/.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const OUT = "apps/video/public/sfx";
mkdirSync(OUT, { recursive: true });

/** One ffmpeg invocation, failing loudly — a silently missing sound is worse than no sound. */
const ff = (name, args) => {
  const res = spawnSync("ffmpeg", ["-y", ...args, `${OUT}/${name}`], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`  FAILED ${name}\n${res.stderr?.slice(-600) ?? ""}`);
    process.exit(1);
  }
  console.log(`  ok  ${name}`);
};

/**
 * A key press.
 *
 * 12ms of pink noise, high-passed and steeply decayed. Real mechanical-keyboard samples are far too
 * present at the density this film types at — roughly ten per second — where anything with body
 * turns into a rattle. This is close to a tick.
 */
ff("key.wav", [
  "-f", "lavfi",
  "-i", "anoisesrc=d=0.012:c=pink:a=0.5",
  "-af", "highpass=f=1800,areverse,afade=t=in:st=0:d=0.010,areverse,volume=0.95",
  "-ar", "48000", "-ac", "2",
]);

/**
 * A message leaving.
 *
 * Two stacked sines a fifth apart with a fast decay — a soft, neutral confirmation rather than the
 * rising major arpeggio every messaging app uses, which would read as an impression of WhatsApp
 * rather than as this product's own voice.
 */
ff("send.wav", [
  "-f", "lavfi", "-i", "sine=frequency=784:duration=0.16",
  "-f", "lavfi", "-i", "sine=frequency=1174:duration=0.16",
  "-filter_complex",
  "[0:a][1:a]amix=inputs=2:duration=shortest,afade=t=out:st=0.02:d=0.14,lowpass=f=5000,volume=0.95[a]",
  "-map", "[a]", "-ar", "48000", "-ac", "2",
]);

/**
 * A message arriving.
 *
 * The same shape a fourth lower, so the pair reads as a call and response. This one lands on the
 * inbound beat, which is the film's payoff, so it is the only sound allowed to be slightly present.
 */
ff("receive.wav", [
  "-f", "lavfi", "-i", "sine=frequency=523:duration=0.20",
  "-f", "lavfi", "-i", "sine=frequency=784:duration=0.20",
  "-filter_complex",
  "[0:a][1:a]amix=inputs=2:duration=shortest,afade=t=out:st=0.03:d=0.17,lowpass=f=4200,volume=0.95[a]",
  "-map", "[a]", "-ar", "48000", "-ac", "2",
]);

/**
 * A bubble landing.
 *
 * Low, short, almost subliminal — the thread fills with five of these in a couple of seconds, so
 * anything longer would smear into a drone.
 */
ff("bubble.wav", [
  "-f", "lavfi", "-i", "sine=frequency=220:duration=0.09",
  "-af", "afade=t=out:st=0.01:d=0.08,lowpass=f=2000,volume=0.95",
  "-ar", "48000", "-ac", "2",
]);

/**
 * A scene change.
 *
 * Band-passed pink noise, swelling and gone in a fifth of a second. Not a cinematic whoosh: the
 * camera moves are small, and a transition sound bigger than its transition is the fastest way to
 * make a restrained film feel cheap.
 */
ff("whoosh.wav", [
  "-f", "lavfi", "-i", "anoisesrc=d=0.22:c=pink:a=0.6",
  "-af",
  "bandpass=f=1200:width_type=o:w=2,afade=t=in:st=0:d=0.09,afade=t=out:st=0.09:d=0.13,volume=0.95",
  "-ar", "48000", "-ac", "2",
]);

console.log("\nok — sound effects written to " + OUT);
