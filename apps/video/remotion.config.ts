import { Config } from "@remotion/cli/config";

/**
 * Rendering is deliberate here, not on the push path: a render pulls a headless Chromium and takes
 * minutes, which is a bad trade on every docs typo.
 */
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
