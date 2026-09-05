import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { Operations } from "@/components/operations";
import { getMDXComponents } from "@/mdx-components";
import { source } from "@/lib/source";

/**
 * Every docs page.
 *
 * Static, like the page it replaces: `generateStaticParams` enumerates the tree at build time, so
 * the whole site is HTML on disk and the Orama search index is built once rather than per request.
 */
export const dynamic = "force-static";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
        {/*
          Rendered here rather than written into each page, so every page that declares coverage
          shows it, in the same place, without any MDX boilerplate to forget.
        */}
        <Operations ids={page.data.operations ?? []} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return { description: page.data.description, title: page.data.title };
}
