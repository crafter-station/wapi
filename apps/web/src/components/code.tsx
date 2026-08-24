import { highlight, type CodeLang } from "@/lib/highlight";
import { CodeTabs } from "./code-tabs";

export type Snippet = { label: string; code: string; lang: CodeLang };

/**
 * Server half of the code block.
 *
 * Highlighting happens here, during the build, so `CodeTabs` stays a small client component
 * that only owns the two things that need a browser: which tab is open, and the clipboard.
 * The raw `code` travels alongside the HTML because that is what gets copied — a reader
 * pasting a snippet should get the snippet, not markup.
 */
export async function Code({ tabs }: { tabs: Snippet[] }) {
  const rendered = await Promise.all(
    tabs.map(async (t) => ({
      code: t.code,
      html: await highlight(t.code, t.lang),
      label: t.label,
    })),
  );
  return <CodeTabs tabs={rendered} />;
}
