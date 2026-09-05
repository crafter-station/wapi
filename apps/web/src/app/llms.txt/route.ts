import { source } from "@/lib/source";

/**
 * `llms.txt` — the documentation as one index, for agents.
 *
 * Generated from the page tree rather than written, so it cannot list a page that no longer
 * exists or miss one that was added. This matters more here than for most projects: wapi ships an
 * agent skill and expects agents to wire it up, and an agent that has to guess at the shape of the
 * docs guesses at the API too.
 */
export const dynamic = "force-static";

const SITE = process.env["WEB_PUBLIC_URL"] ?? "https://wapi.crafter.run";

export function GET() {
  const lines = [
    "# wapi",
    "",
    "> WhatsApp over HTTP. A self-hosted clone of the WasenderAPI surface, with a sandbox that",
    "> lets you build and test without a real phone number.",
    "",
    "## Docs",
    "",
  ];

  for (const page of source.getPages()) {
    const description = page.data.description ? `: ${page.data.description}` : "";
    lines.push(`- [${page.data.title}](${SITE}${page.url})${description}`);
  }

  lines.push(
    "",
    "## Reference",
    "",
    `- [API reference](https://api.wapi.crafter.run/docs): all 57 endpoints, generated from the contract.`,
    `- [OpenAPI document](https://api.wapi.crafter.run/openapi.json): the raw spec.`,
    "",
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
