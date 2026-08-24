import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Build-time syntax highlighting.
 *
 * The docs page is `force-static`, so every snippet is highlighted once during the build and
 * ships as plain HTML. No highlighter reaches the browser: the client bundle is unchanged and
 * there is no flash of unstyled code on load.
 *
 * The JavaScript regex engine is used rather than the default Oniguruma one, which pulls in a
 * WASM binary. The four grammars here are all supported by it, and avoiding a WASM asset keeps
 * the webpack build a plain JS build.
 */
const LANGS = ["bash", "json", "javascript", "python"] as const;
export type CodeLang = (typeof LANGS)[number];

/**
 * Two themes, resolved by the reader's own colour scheme.
 *
 * Shiki emits both colours per token — one inline, one as a `--shiki-dark` custom property —
 * and `globals.css` swaps them under `prefers-color-scheme: dark`. That matches how the rest
 * of the site themes itself, and means a snippet is never light-on-light.
 */
const THEMES = { dark: "github-dark", light: "github-light" } as const;

let instance: Promise<Highlighter> | null = null;

const highlighter = () =>
  (instance ??= createHighlighter({
    engine: createJavaScriptRegexEngine(),
    langs: [...LANGS],
    themes: [THEMES.light, THEMES.dark],
  }));

export async function highlight(code: string, lang: CodeLang): Promise<string> {
  const shiki = await highlighter();
  return shiki.codeToHtml(code, {
    defaultColor: "light",
    lang,
    themes: THEMES,
  });
}
