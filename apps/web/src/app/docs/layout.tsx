import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import "fumadocs-ui/style.css";
import "./docs.css";

/**
 * The docs shell.
 *
 * `theme.enabled: false` switches off `next-themes`, which is deliberate and load-bearing. This
 * site has no `.dark` class and no toggle: `globals.css` swaps its tokens on
 * `@media (prefers-color-scheme: dark)`, and the shiki setup swaps code colours the same way via
 * `--shiki-dark`. Letting Fumadocs mount a class-based theme switcher would leave the docs and
 * the dashboard disagreeing about what "dark" means the moment somebody used it. Instead the
 * whole site follows the reader's system setting, and `docs.css` maps Fumadocs' tokens onto ours.
 *
 * The nav title is the same wordmark as the landing (`wapi.`) and links home — Jakob's law plus
 * brand continuity so the guide does not feel like a different product from the marketing page.
 */
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ options: { api: "/api/search" } }} theme={{ enabled: false }}>
      <DocsLayout
        tree={source.pageTree}
        nav={{
          title: (
            <span className="wordmark text-[1.05rem]">
              wapi<span>.</span>
            </span>
          ),
          url: "/",
        }}
        githubUrl="https://github.com/crafter-station/wapi"
        links={[
          {
            text: "API reference",
            url: "https://api.wapi.crafter.run/docs",
            external: true,
          },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
