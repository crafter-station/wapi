import { highlight, type CodeLang } from "@/lib/highlight";
import { CodeTabs } from "./code-tabs";
import { CopyButton } from "./copy-button";

export type Snippet = { label: string; code: string; lang: CodeLang };

/**
 * Server half of the code blocks.
 *
 * Highlighting happens here, during the build, so the client components stay small and own only
 * what needs a browser: which tab is open, and the clipboard.
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

/**
 * A single block, for the places a tab strip would be noise — one error envelope, one curl.
 *
 * It carries the same chrome and the same copy button as the tabbed version. Anything that
 * looks like code a reader might paste should be copyable, and having two kinds of block where
 * only one could be copied was the inconsistency worth removing.
 */
export async function CodeBlock({
  label,
  code,
  lang,
}: {
  label?: string;
  code: string;
  lang: CodeLang;
}) {
  const html = await highlight(code, lang);
  return (
    <div className="not-prose terminal">
      <div className="terminal-bar">
        {label ? <span className="truncate">{label}</span> : null}
        <CopyButton text={code} className="ml-auto" />
      </div>
      <div className="terminal-body">
        <div className="code" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
