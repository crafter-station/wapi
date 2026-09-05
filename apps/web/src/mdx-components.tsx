import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CommandTable } from "@/components/command-table";

/**
 * Components available to every MDX page.
 *
 * Registered globally rather than imported per page: an import line at the top of twenty MDX files
 * is twenty chances to forget one, and the failure mode is a page that renders the component name
 * as text.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...defaultComponents, CommandTable, Tab, Tabs, ...components };
}
