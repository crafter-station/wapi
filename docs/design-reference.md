# Design reference — extracted from https://normal.fast

Read from the live CSS bundles (`_next/static/chunks/233p45nuh4m5b.css`, `44sm4aufd6b0r.css`)
on 2026-08-23. These are measured values, not impressions.

**What the site is:** Normal — WhatsApp ↔ MCP for ChatGPT/Claude. Next.js + Turbopack + Clerk,
which is the same stack we're standing on.

## System

Tailwind **v4** (`--spacing: .25rem`, `@theme` token layer, `lab()` colour space) with the full
**shadcn/ui** token set — `card`, `popover`, `sidebar`, `chart-1..5`, `ring`, `input`, `accent`,
`destructive`. Radius `--radius: .625rem` (10px).

## Palette — pure neutral, zero chroma

| Token | Light | Dark |
|---|---|---|
| `background` | `#ffffff` | `#0a0a0a` |
| `foreground` | `#0a0a0a` | `#fafafa` |
| `card` / `popover` | `#ffffff` | `#171717` |
| `muted` | `#f5f5f5` | `#262626` |
| `muted-foreground` | `#737373` | `#a1a1a1` |
| `border` | `#e5e5e5` | `rgba(255,255,255,.10)` |
| `input` | `#e5e5e5` | `rgba(255,255,255,.15)` |
| `primary` | `#171717` | `#e5e5e5` |
| `ring` | `#737373` | `#a1a1a1` |
| `destructive` | `#e40014` | `#ff6568` |

Charts are a **grayscale ramp**: `#d4d4d4 · #737373 · #525252 · #404040 · #262626`.

**There is no brand colour.** `destructive` is the only chromatic token in the system. One stray
`--sidebar-primary: #1447e6` (blue) appears in dark mode while its light-mode sibling is `#171717` —
an unoverridden shadcn default, not a deliberate accent. Don't copy it.

## Semantic alias layer

A second, editorial naming layer sits on top of the shadcn tokens:

```css
--landing-paper: var(--background);
--landing-ink:   var(--foreground);
--landing-line:  var(--border);
--landing-wash:  var(--muted);
```

Print vocabulary — paper, ink, line, wash. Worth adopting; it makes landing-surface intent explicit
and separable from component tokens.

## Typography

- **Geist Sans** (`--font-geist-sans`) and **Geist Mono** (`--font-geist-mono`), with `Fallback` faces.
- Weights defined: **400, 500, 600 only**. No 700 — emphasis comes from size and colour, not bold.
- Scale: `xs .75 · sm .875 · base 1 · lg 1.125 · xl 1.25 · 2xl 1.5 · 3xl 1.875 · 4xl 2.25` (rem),
  each with a paired line-height.
- Leading: `tight 1.25 · snug 1.375 · normal 1.5`.
- Tracking: `tight -.025em` (headings), `widest .1em` (eyebrows/labels).

## Motion

Fast and short — durations `.1s`, `.15s`, `.2s`. Default `--default-transition-duration: .15s`.

```css
--ease-out:    cubic-bezier(.23, 1, .32, 1);      /* expo-out, decisive */
--ease-in-out: cubic-bezier(.77, 0, .175, 1);     /* strong both ends */
```

## Effects

- `--blur-xs: 4px` backdrop blur.
- `--shimmer-angle: 20deg` with a shimmer image/text-fill treatment.
- Scroll-fade masks (`--scroll-fade-s/e/t/b`) for edge-faded scroll containers.
- **Dashed borders** are in active use (`--tw-border-style: dashed`), not just solid.
- Containers: `xs 20rem → 6xl 72rem`.

## The consequence for our dashboard

A zero-chroma palette means the usual green/amber/red status treatment is unavailable. Our session
states — `connected`, `connecting`, `need_scan`, `need_passkey`, `disconnected`, `logged_out`,
`expired` — have to be distinguished by **weight, fill, dashed vs solid border, and mono labels**,
with `destructive` reserved for genuine failure (`logged_out`, `expired`). See PLAN.md.
