/**
 * The film's surface, taken from the site rather than invented.
 *
 * `docs/design-reference.md` records these as measured values, and `globals.css` is where they
 * live in the product. Two things carry the voice and both are reproduced here: the palette is
 * achromatic — there is no brand colour, so emphasis has to come from weight, fill and rule — and
 * headings set one phrase in Georgia italic against the sans.
 *
 * Deliberately a light film. The site defaults to light and only follows a reader's dark
 * preference; a video has no reader preference to follow, so it picks the default.
 */
export const theme = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  card: "#ffffff",
  muted: "#f5f5f5",
  mutedForeground: "#737373",
  border: "#e5e5e5",
  /** The only chromatic token in the whole system. Used for nothing decorative. */
  destructive: "#e40014",
  radius: 10,
} as const;

/**
 * Georgia for the emphasised phrase, a system sans for everything else.
 *
 * Georgia rather than a loaded webfont, for the same reason the site gives: it needs no network
 * request and the contrast comes from the letterforms, not from the specific face. In a video that
 * argument is stronger — a font that fails to load renders a frame wrong permanently.
 */
export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;

export const FPS = 30;
export const WIDTH = 1120;
export const HEIGHT = 630;
