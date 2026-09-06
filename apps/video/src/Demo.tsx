import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Phone, type ThreadMessage } from "./components/Phone";
import { Terminal } from "./components/Terminal";
import { font, FPS, theme } from "./theme";
import thread from "../public/captures/thread.json";
import transcript from "../public/captures/transcript.json";

type Step = { command: string; stdoutPlain: string };

/**
 * A recorded step, by the command that produced it.
 *
 * Throws rather than falling back, and that is the point: if the capture is re-run and a command
 * changes, the render fails loudly instead of quietly rendering an empty terminal. A demo that
 * silently drops a beat is exactly the failure this whole pipeline exists to avoid.
 */
const step = (match: string): Step => {
  const found = (transcript.steps as Step[]).find((s) => s.command.includes(match));
  if (!found) {
    throw new Error(
      `No captured step matching "${match}". Re-run \`node ops/capture-demo.mjs\`, or fix the match.`,
    );
  }
  return found;
};

const messages = thread as ThreadMessage[];

/** Seconds → frames, so the beat sheet reads the way it was written. */
const s = (seconds: number) => Math.round(seconds * FPS);

/**
 * The camera.
 *
 * One perspective container for the whole film rather than per scene, so depth is consistent:
 * a panel at `translateZ(-200px)` is the same distance away in every beat. Everything on screen is
 * a flat rectangle, which is why this is CSS 3D and not WebGL — there is no geometry here, only
 * planes moving in space.
 */
const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      alignItems: "center",
      background: theme.background,
      color: theme.foreground,
      fontFamily: font.sans,
      justifyContent: "center",
      perspective: 1400,
      perspectiveOrigin: "50% 45%",
    }}
  >
    {children}
  </AbsoluteFill>
);

/** A phrase with one Georgia-italic fragment — the site's signature, and the film's. */
const Title: React.FC<{ plain: string; italic: string }> = ({ plain, italic }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ config: { damping: 200 }, durationInFrames: 26, fps, frame });
  // A slow push-in. Large enough to feel, small enough not to read as a zoom.
  const z = interpolate(enter, [0, 1], [-120, 0]);

  return (
    <div
      style={{
        fontSize: 62,
        letterSpacing: "-0.035em",
        lineHeight: 1.1,
        opacity: enter,
        textAlign: "center",
        transform: `translateZ(${z}px)`,
      }}
    >
      {plain}{" "}
      <span style={{ fontFamily: font.serif, fontStyle: "italic", letterSpacing: "-0.045em" }}>
        {italic}
      </span>
    </div>
  );
};

/** The site itself, panned. A capture rather than a rebuild, so it cannot drift from the real page. */
const LandingScene: React.FC<{ durationInFrames: number }> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  // Down the page, eased, so it reads as reading rather than as a scrollbar being dragged.
  const y = interpolate(frame, [0, durationInFrames], [0, -1500], {
    easing: Easing.inOut(Easing.ease),
    extrapolateRight: "clamp",
  });
  const yaw = interpolate(frame, [0, durationInFrames], [10, 4]);
  const z = interpolate(frame, [0, durationInFrames], [-360, -180]);
  const fade = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        height: 630,
        opacity: fade,
        overflow: "hidden",
        transform: `translateZ(${z}px) rotateY(${yaw}deg)`,
        width: 900,
      }}
    >
      <Img
        src={staticFile("captures/landing.jpg")}
        style={{ display: "block", transform: `translateY(${y}px)`, width: "100%" }}
      />
    </div>
  );
};

/** A terminal beat: one captured command, arriving in depth. */
const TerminalScene: React.FC<{
  command: string;
  label?: string;
  match: string;
  yaw?: number;
}> = ({ command, label, match, yaw = -8 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ config: { damping: 200 }, durationInFrames: 24, fps, frame });
  const captured = step(match);

  return (
    <div
      style={{
        opacity: enter,
        transform: `translateZ(${interpolate(enter, [0, 1], [-260, 0])}px) rotateY(${interpolate(
          enter,
          [0, 1],
          [yaw, 0],
        )}deg)`,
      }}
    >
      <Terminal command={command} label={label} output={captured.stdoutPlain} />
    </div>
  );
};

/** Terminal and phone together: the command on the left, what it produced on the right. */
const SplitScene: React.FC<{
  command: string;
  label?: string;
  match: string;
  phoneStart?: number;
  shown: ThreadMessage[];
  stagger?: number;
  title?: string;
}> = ({ command, label, match, phoneStart = 26, shown, stagger = 14, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const captured = step(match);
  // The phone swings in from the right and settles — the one moment the film is overtly kinetic.
  const phone = spring({ config: { damping: 200 }, durationInFrames: 30, fps, frame: frame - phoneStart });

  return (
    <div style={{ alignItems: "center", display: "flex", gap: 56 }}>
      <div style={{ transform: "translateZ(-40px) rotateY(6deg)" }}>
        <Terminal command={command} label={label} output={captured.stdoutPlain} width={560} />
      </div>
      <div
        style={{
          opacity: phone,
          transform: `translateX(${interpolate(phone, [0, 1], [120, 0])}px) rotateY(${interpolate(
            phone,
            [0, 1],
            [-26, -8],
          )}deg) translateZ(${interpolate(phone, [0, 1], [-160, 0])}px)`,
        }}
      >
        <Phone messages={shown} stagger={stagger} startAt={phoneStart + 10} title={title} />
      </div>
    </div>
  );
};

/**
 * The film.
 *
 * Timings are the agreed beat sheet in seconds, converted once, so the table in the plan and the
 * code stay legible against each other. Every terminal body and every bubble comes from
 * `public/captures`, recorded by `ops/capture-demo.mjs` against a real sandbox.
 */
export const Demo: React.FC = () => {
  const direct = messages.filter((m) => m.kind !== "text" || m.text === "hello from wapi");
  const upToText = messages.slice(0, 1);
  const withAttachments = messages.slice(0, 5);
  const withGroup = messages.slice(0, 6);
  const everything = messages;

  return (
    <Stage>
      <Sequence durationInFrames={s(8)} name="Landing">
        <LandingScene durationInFrames={s(8)} />
      </Sequence>

      <Sequence durationInFrames={s(5)} from={s(8)} name="Title">
        <Title italic="No QR." plain="No phone." />
      </Sequence>

      <Sequence durationInFrames={s(6)} from={s(13)} name="Create">
        <TerminalScene command="wapi sandbox create --use" match="sandbox create" />
      </Sequence>

      <Sequence durationInFrames={s(5)} from={s(19)} name="Connect">
        <TerminalScene command="wapi sessions connect" match="sessions connect" yaw={8} />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(24)} name="Send">
        <SplitScene
          command='wapi send --to +999… --text "hello from wapi"'
          label="POST /api/send-message"
          match="--text hello from wapi"
          shown={upToText}
        />
      </Sequence>

      <Sequence durationInFrames={s(11)} from={s(31)} name="Attachments">
        <SplitScene
          command="wapi media upload photo.png"
          label="POST /api/upload"
          match="media upload photo.png"
          phoneStart={0}
          shown={withAttachments}
          stagger={16}
        />
      </Sequence>

      <Sequence durationInFrames={s(8)} from={s(42)} name="Group">
        <SplitScene
          command='wapi send --to "Sandbox Team" --text "shipping Friday"'
          label="a group is just another recipient"
          match="groups list"
          phoneStart={0}
          shown={withGroup}
          stagger={10}
          title="Sandbox Team"
        />
      </Sequence>

      <Sequence durationInFrames={s(10)} from={s(50)} name="Inbound">
        <SplitScene
          command='wapi sandbox inbound "and a reply"'
          label="POST /api/sandbox/inbound"
          match="sandbox inbound"
          phoneStart={0}
          shown={everything}
          stagger={8}
        />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(60)} name="Payoff">
        <Title italic="From a fake human." plain="A real message." />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(67)} name="End">
        <EndCard />
      </Sequence>
    </Stage>
  );
};

/** Flat and still, on purpose: the one frame somebody might pause on should not be moving. */
const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  return (
    <div style={{ opacity: fade, textAlign: "center" }}>
      <div style={{ fontSize: 46, letterSpacing: "-0.03em" }}>
        WhatsApp over HTTP,{" "}
        <span style={{ fontFamily: font.serif, fontStyle: "italic" }}>on your own box.</span>
      </div>
      <div style={{ color: theme.mutedForeground, fontSize: 20, marginTop: 22 }}>
        wapi.crafter.run
      </div>
      <div
        style={{
          background: theme.muted,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          display: "inline-block",
          fontFamily: font.mono,
          fontSize: 15,
          marginTop: 26,
          padding: "10px 16px",
        }}
      >
        wapi sandbox create --use
      </div>
    </div>
  );
};
