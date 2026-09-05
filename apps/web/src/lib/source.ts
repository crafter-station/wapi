import { loader } from "fumadocs-core/source";
import { docs } from "../../.source/server";

/** The page tree, read by the layout, the pages, the search index and `llms.txt`. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
