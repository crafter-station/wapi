# WasenderAPI documentation mirror

Downloaded 2026-08-23 from https://wasenderapi.com/api-docs — 99 pages, 11 categories, 50 API routes.

| Path | What |
|---|---|
| `llms.txt` | Original 588 KB dump from `https://wasenderapi.com/llms.txt` — the complete reference, verbatim |
| `INDEX.md` | Category index split out of `llms.txt` |
| `reference/<category>/<slug>.md` | 99 per-endpoint markdown files (description, parameters, code examples in 12 languages, response examples) |
| `raw/<category>/<slug>.html` | 99 original HTML pages (17 MB) |
| `structured/entries.json` | All 99 CMS rows extracted from the Inertia payload — the source-of-truth data model |
| `structured/categories.json` | The 11 category rows |
| `structured/endpoints.json` | 64 documented operations normalised to `{method, path, parameters, responses}` |
| `API-SURFACE.md` | Route tables per category + the 50 unique routes |
| `TECH-STACK.md` | Technology investigation |
| `urls.txt`, `manifest.json`, `split.mjs` | Provenance |

## Category counts

| Category | Pages |
|---|---|
| sessions | 21 |
| webhooks | 24 |
| messages | 18 |
| groups | 15 |
| contacts | 8 |
| getting-started | 6 |
| authentication | 2 |
| responses-errors | 2 |
| developer-sdks | 1 |
| channels-communities | 1 |
| rate-limits | 1 |

## The one structural fact that shapes a clone

`POST /api/send-message` is a **single polymorphic endpoint** documented 14 different ways.
Its full field union:

```
to (required) · text · imageUrl · videoUrl · documentUrl · audioUrl · stickerUrl
fileName · contact{} · location{} · poll{question,options[],multiSelect}
mentions[] · replyTo (msgId) · viewOnce
```

Discriminated by which media field is present. Everything else — group message, channel message,
mention message, quoted message, view-once — is the same route with a different field set.
