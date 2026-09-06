import { Audio, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { font, theme } from "../theme";

/**
 * Key clicks, one every few characters.
 *
 * Not one per character: the film types at roughly ten a second, and at that density individual
 * clicks smear into a rattle. Every third character reads as typing while staying texture rather
 * than becoming a rhythm the eye starts following.
 */
const KeySounds: React.FC<{ count: number; from: number; every?: number }> = ({
  count,
  from,
  every = 3,
}) => (
  <>
    {Array.from({ length: Math.floor(count / every) }, (_, i) => (
      <Sequence durationInFrames={2} from={from + i * every} key={i}>
        <Audio src={staticFile("sfx/key.wav")} volume={0.16} />
      </Sequence>
    ))}
  </>
);

/**
 * A terminal panel, matching the one on the landing page.
 *
 * Same chrome as `HeroTerminal` in `apps/web/src/app/page.tsx` — a status bar with a route on the
 * right, a hairline rule, monospace body — so the film and the site are visibly the same product.
 *
 * The content is never written here. It comes from `public/captures/transcript.json`, which is
 * what the real CLI actually printed.
 */
export const Terminal: React.FC<{
  /** What the film shows being typed. */
  command: string;
  /** Verbatim output, ANSI already stripped by the capture. */
  output: string;
  /** Frame at which typing starts, relative to this component's sequence. */
  typeStart?: number;
  /** How long the command takes to type, in frames. */
  typeDuration?: number;
  /** Frames after typing finishes before output appears — a real command is not instant. */
  outputDelay?: number;
  label?: string;
  width?: number;
}> = ({
  command,
  output,
  typeStart = 0,
  typeDuration = 22,
  outputDelay = 8,
  label,
  width = 620,
}) => {
  const frame = useCurrentFrame();

  /**
   * Typed a character at a time, floored rather than eased.
   *
   * A command that fades in reads as a slide; a command that types reads as somebody using the
   * tool. The cursor keeps blinking until the output lands, which is what makes the pause between
   * them feel like waiting rather than like a dropped frame.
   */
  const typed = Math.floor(
    interpolate(frame, [typeStart, typeStart + typeDuration], [0, command.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const typing = typed < command.length;
  const outputAt = typeStart + typeDuration + outputDelay;
  const outputOpacity = interpolate(frame, [outputAt, outputAt + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Blinks twice a second while typing, and settles once the command has run.
  const cursor = typing && Math.floor(frame / 8) % 2 === 0;

  return (
    <>
      {/*
        Typing, then the soft confirmation when output lands.

        Levels are deliberately low. The first render peaked at -0.6 dBFS — close to clipping for a
        key click — and there is a music bed to come; effects have to sit under it rather than
        compete. Set here rather than in the source files so one place governs the mix.
      */}
      <KeySounds count={typeDuration} from={typeStart} />
      <Sequence durationInFrames={8} from={outputAt}>
        <Audio src={staticFile("sfx/send.wav")} volume={0.34} />
      </Sequence>
      <div
      style={{
        background: theme.card,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        // A single soft shadow, not a stack: depth here comes from the camera, not from CSS.
        boxShadow: "0 24px 60px rgba(10,10,10,0.10)",
        fontFamily: font.mono,
        overflow: "hidden",
        width,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${theme.border}`,
          color: theme.mutedForeground,
          display: "flex",
          fontSize: 12,
          letterSpacing: "0.02em",
          padding: "10px 14px",
        }}
      >
        <span>wapi</span>
        {label ? <span style={{ marginLeft: "auto" }}>{label}</span> : null}
      </div>

      <div style={{ fontSize: 15, lineHeight: 1.65, padding: "16px 18px", whiteSpace: "pre-wrap" }}>
        <div>
          <span style={{ color: theme.mutedForeground }}>$ </span>
          <span style={{ color: theme.foreground }}>{command.slice(0, typed)}</span>
          {cursor ? (
            <span style={{ background: theme.foreground, color: theme.card }}>&nbsp;</span>
          ) : null}
        </div>
        <div style={{ color: theme.mutedForeground, marginTop: 8, opacity: outputOpacity }}>
          {output.trimEnd()}
        </div>
      </div>
      </div>
    </>
  );
};
