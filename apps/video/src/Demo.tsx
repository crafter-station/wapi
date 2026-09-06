import {
  AbsoluteFill,
  Audio,
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
import realThread from "../public/captures/real-thread.json";
import realTranscript from "../public/captures/real-transcript.json";
import sandboxThread from "../public/captures/sandbox-thread.json";
import sandboxTranscript from "../public/captures/sandbox-transcript.json";

type Step = { command: string; stdoutPlain: string };
type Transcript = { steps: Step[] };

/**
 * A recorded step, by the command that produced it.
 *
 * Throws rather than falling back, and that is the point: if the capture is re-run and a command
 * changes, the render fails loudly instead of quietly rendering an empty terminal. A demo that
 * silently drops a beat is exactly the failure this whole pipeline exists to avoid.
 */
const stepFrom = (transcript: Transcript, match: string): Step => {
  const found = transcript.steps.find((s) => s.command.includes(match));
  if (!found) {
    throw new Error(
      `No captured step matching "${match}". Re-run \`node ops/capture-demo.mjs\`, or fix the match.`,
    );
  }
  return found;
};

const real = (match: string) => stepFrom(realTranscript as Transcript, match);
const sandbox = (match: string) => stepFrom(sandboxTranscript as Transcript, match);

/** The masked number, from the capture. The digits never enter this repo, so they cannot leak. */
const MASKED = (realTranscript as { masked?: string }).masked ?? "";

const realMessages = realThread as ThreadMessage[];
const sandboxMessages = sandboxThread as ThreadMessage[];

/** Seconds → frames, so the beat sheet reads the way it was written. */
const s = (seconds: number) => Math.round(seconds * FPS);

/**
 * The camera.
 *
 * One perspective container for the whole film rather than per scene, so depth is consistent: a
 * panel at `translateZ(-200px)` is the same distance away in every beat. Everything on screen is a
 * flat rectangle, which is why this is CSS 3D and not WebGL — there is no geometry here, only
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

/** A scene change. Quiet — the camera moves are small, and a bigger sound than its move reads cheap. */
const Whoosh: React.FC = () => (
  <Sequence durationInFrames={10}>
    <Audio src={staticFile("sfx/whoosh.wav")} volume={0.28} />
  </Sequence>
);

/** A phrase with one Georgia-italic fragment — the site's signature, and the film's. */
const Title: React.FC<{ italic: string; plain: string; sub?: string }> = ({
  italic,
  plain,
  sub,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ config: { damping: 200 }, durationInFrames: 26, fps, frame });
  // A slow push-in. Large enough to feel, small enough not to read as a zoom.
  const z = interpolate(enter, [0, 1], [-120, 0]);

  return (
    <div style={{ opacity: enter, textAlign: "center", transform: `translateZ(${z}px)` }}>
      <div style={{ fontSize: 62, letterSpacing: "-0.035em", lineHeight: 1.1 }}>
        {plain}{" "}
        <span style={{ fontFamily: font.serif, fontStyle: "italic", letterSpacing: "-0.045em" }}>
          {italic}
        </span>
      </div>
      {sub ? (
        <div style={{ color: theme.mutedForeground, fontSize: 20, marginTop: 20 }}>{sub}</div>
      ) : null}
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

/** A terminal beat on its own, arriving in depth. */
const TerminalScene: React.FC<{
  command: string;
  label?: string;
  output: string;
  yaw?: number;
}> = ({ command, label, output, yaw = -8 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ config: { damping: 200 }, durationInFrames: 24, fps, frame });

  return (
    <>
      <Whoosh />
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
        <Terminal command={command} label={label} output={output} />
      </div>
    </>
  );
};

/** Terminal and phone together: the command on the left, what it produced on the right. */
const SplitScene: React.FC<{
  command: string;
  label?: string;
  output: string;
  phoneStart?: number;
  shown: ThreadMessage[];
  stagger?: number;
  subtitle?: string;
  title?: string;
}> = ({ command, label, output, phoneStart = 26, shown, stagger = 14, subtitle, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The phone swings in from the right and settles — the one moment the film is overtly kinetic.
  const phone = spring({
    config: { damping: 200 },
    durationInFrames: 30,
    fps,
    frame: frame - phoneStart,
  });

  /*
   * Nudged right, because geometric centring is not optical centring here.
   *
   * Both panels are yawed under a shared perspective, which swings their near edges outward and
   * leaves the pair reading about 60px left of where the box model puts it.
   */
  return (
    <>
      <Whoosh />
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 44,
          justifyContent: "center",
          transform: "translateX(56px)",
        }}
      >
        <div style={{ transform: "translateZ(-40px) rotateY(6deg)" }}>
          <Terminal command={command} label={label} output={output} width={560} />
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
          <Phone
            messages={shown}
            stagger={stagger}
            startAt={phoneStart + 10}
            subtitle={subtitle}
            title={title}
          />
        </div>
      </div>
    </>
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
        wapi login
      </div>
    </div>
  );
};

/**
 * The film, in two halves.
 *
 * **Real first.** Everything up to 0:39 is a live WhatsApp account: real sends, real media, a real
 * group, and WhatsApp's own delivery acknowledgement read back per message. The number is masked at
 * capture time, so the digits are not in this repo and cannot reach the screen.
 *
 * **Then the sandbox**, as a feature rather than as the whole product — which is what the earlier
 * cut accidentally implied. It is also the only way to show the payoff: there is no way to
 * fabricate an inbound message on a real session, and a message you send from your own linked phone
 * arrives as `fromMe`. The sandbox exists precisely for that gap, so the film says so.
 */
export const Demo: React.FC = () => {
  const text = realMessages.slice(0, 1);
  const attachments = realMessages.slice(0, 5);
  const withGroup = realMessages.slice(0, 6);

  return (
    <Stage>
      <Sequence durationInFrames={s(7)} name="Landing">
        <LandingScene durationInFrames={s(7)} />
      </Sequence>

      <Sequence durationInFrames={s(5)} from={s(7)} name="Title">
        <Title italic="over HTTP." plain="Your WhatsApp," sub="Your number. Your server." />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(12)} name="Send">
        <SplitScene
          command={`wapi send --to ${MASKED} --text "hello from wapi"`}
          label="POST /api/send-message"
          output={real('--text "hello from wapi"').stdoutPlain}
          shown={text}
          subtitle={MASKED}
          title="You"
        />
      </Sequence>

      <Sequence durationInFrames={s(12)} from={s(19)} name="Attachments">
        <SplitScene
          command="wapi media upload photo.png"
          label="POST /api/upload"
          output={real("media upload photo.png").stdoutPlain}
          phoneStart={0}
          shown={attachments}
          stagger={17}
          subtitle={MASKED}
          title="You"
        />
      </Sequence>

      <Sequence durationInFrames={s(8)} from={s(31)} name="Group">
        <SplitScene
          command={'wapi send --to "Bots" --text "shipping Friday"'}
          label="a group is just another recipient"
          output={real('--to "Bots"').stdoutPlain}
          phoneStart={0}
          shown={withGroup}
          stagger={10}
          subtitle="72 people · a real group"
          title="Bots"
        />
      </Sequence>

      {/* ---------------------------------------------------------------- the sandbox half */}
      <Sequence durationInFrames={s(6)} from={s(39)} name="SandboxTitle">
        <Title
          italic="no QR."
          plain="And a sandbox —"
          sub="for building against, before you point it at a real number"
        />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(45)} name="SandboxCreate">
        <TerminalScene
          command="wapi sandbox create --use"
          label="a fake number, on a fake WhatsApp"
          output={sandbox("sandbox create").stdoutPlain}
        />
      </Sequence>

      <Sequence durationInFrames={s(10)} from={s(52)} name="Inbound">
        <SplitScene
          command={'wapi sandbox inbound "and a reply"'}
          label="POST /api/sandbox/inbound"
          output={sandbox("sandbox inbound").stdoutPlain}
          phoneStart={0}
          shown={sandboxMessages}
          stagger={9}
          title="Sandbox"
        />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(62)} name="Payoff">
        <Title italic="From a fake human." plain="A real webhook." />
      </Sequence>

      <Sequence durationInFrames={s(7)} from={s(69)} name="End">
        <EndCard />
      </Sequence>
    </Stage>
  );
};
