import { Composition } from "remotion";
import { Demo } from "./Demo";
import { FPS, HEIGHT, WIDTH } from "./theme";

/**
 * 1120x630 — twice the 560px column the landing page gives the hero panel, at 16:9.
 *
 * Sized for where it is embedded rather than for a format: a 1920x1080 master would be downscaled
 * on every view, and terminal text is the one thing that does not survive that.
 */
export const Root: React.FC = () => (
  <Composition
    component={Demo}
    durationInFrames={FPS * 74}
    fps={FPS}
    height={HEIGHT}
    id="Demo"
    width={WIDTH}
  />
);
