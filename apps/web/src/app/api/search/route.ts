import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

/**
 * Docs search.
 *
 * Orama, built from the same page tree the sidebar renders, so a page cannot be findable in one
 * and missing from the other. Twenty-two pages is past the point where an anchor list works, and
 * the index is small enough that it needs no external search service.
 */
export const { GET } = createFromSource(source);
