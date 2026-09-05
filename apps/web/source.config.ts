import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

/**
 * The content source.
 *
 * `operations` is the only field added to the stock frontmatter, and it is the contract between a
 * page and `ops/check-docs-in-sync.mjs`: every one of the API's operations must be claimed by some
 * page, and every id claimed must still exist. Declared rather than inferred, for the same reason
 * `SCOPES` and `COVERAGE` are — a guard that scraped links out of prose could not tell coverage
 * from a passing mention, and would silently un-cover an endpoint the moment somebody reworded a
 * sentence. The page renders its own "operations covered" list from this same field, so the guard
 * and the page cannot disagree.
 */
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.extend({
      operations: z.array(z.string()).optional(),
    }),
  },
});

export default defineConfig();
