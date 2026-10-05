# Smart Reading

A local-first place to read, search and keep what you learn.

> Index everything. Make knowledge durable only when you accept it. Keep every idea traceable to its source.

- **Library**: drop in PDFs, Markdown or text files. They are read and indexed. Nothing is generated on upload.
- **Search**: one box. Exact phrases, `AND` / `OR` / `NOT`, `title:` / `author:` / `note:`, filters (`type:idea`, `status:unread`, `kind:pdf`) and meaning search (describe an idea in your own words). Every hit shows the page and why it matched.
- **Reader**: read the PDF inside the app, select text, then **Highlight**, **Keep as Quote**, **Write idea…** or **Distill**.
- **Knowledge**: what you accepted, as Quote / Idea / Concept / Question. Each one is tied to an exact span of its source. You can link two units as *same idea*, *supports* or *contradicts*.
- **Distill** (optional): an AI proposes up to 3 candidates from your selection. They are never saved unless you accept them, and any candidate whose supporting quote is not found verbatim in your selection is dropped.

## Run it

Requires Node 22+ (developed on 24).

```
npm install
npm start          # builds the UI, then serves http://localhost:4177
```

For development with hot reload: `npm run dev` (UI on http://localhost:5173, API on 4177).

Your data lives in `library-data/` (override with `LIBRARY_DIR`): the SQLite database, the original files, the downloaded model and `settings.json`.

The first run downloads the meaning-search model (about 130 MB, once). Until it is ready, search works with keywords only and the header says so.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBRARY_DIR` | `library-data` | where everything is stored |
| `PORT` | `4177` | the server only listens on `127.0.0.1` |
| `EMBEDDINGS` | `on` | `off` disables meaning search (keywords only) |
| `EMBED_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | any compatible sentence-embedding model |
| `SEMANTIC_MIN` | `0.4` | minimum similarity for a meaning-only hit |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | none | provider for Distill (can also be set in **Settings**) |

**Distill provider.** Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, or a local one such as Ollama (`http://localhost:11434/v1`, any API key). The key is stored in `library-data/settings.json`, never sent anywhere except to the URL you set, and blanked in backups. Without a provider, everything else still works.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | unit and integration tests |
| `npm run eval` | acceptance gates on a fixed set of PDFs and queries, using the real model |
| `npm run embeddings:rebuild` | rebuild all meaning vectors (needed after changing `EMBED_MODEL`) |
| `npm run export` | write a portable `export.json` + `export.md` (units with their source, page and text) |
| `npm run backup -- create [dir]` | consistent copy of database and originals |
| `npm run backup -- restore <dir> [--force]` | restore into `LIBRARY_DIR` (stop the app first) |

Embeddings are derived data. Your knowledge (units, highlights, links) never depends on a model, so changing models is a rebuild, not a migration.

## How it works

- **Ingest**: pdf.js extracts text per page. Each page is marked `ok`, `empty` or `garbled`. A document is **Ready**, **Partial** (some pages unreadable, listed) or **Failed** (nothing readable, for example a scan). Text is split into passages of at most 90 words, never crossing a page.
- **Anchoring**: a quote is always `pageText.slice(start, end)`, so it is an exact substring of the source by construction. If a file is re-processed, units are re-anchored by their surrounding text, and shown as *stale* if they cannot be found.
- **Search**: SQLite FTS5 (BM25, stemming, accent folding) plus local embeddings (brute-force cosine), merged with reciprocal rank fusion. Queries with quotes or operators put exact matches first.
- **Safety**: a document that has saved units cannot be removed without an explicit confirmation.

## Known limits

- **No OCR.** Scanned PDFs are reported as Partial or Failed, with the reason; they are not guessed at.
- Multi-column PDFs are read as a single column, so text from adjacent columns can interleave.
- Words split by a hyphen at a line end are rejoined for search and meaning only (the stored text and your quotes keep the original characters). A real compound that happens to break at a line end ("well-" / "known") is indexed as one word.
- A selection has to be inside one page.
- One user, one library, no sync, no accounts.

## Assumptions to confirm

These were open questions; the defaults below keep the choice reversible.

1. **Languages**: the default model is multilingual, so non-English documents work. If you only read English, a smaller English model could be faster. Change `EMBED_MODEL` and run `npm run embeddings:rebuild`.
2. **AI provider for Distill**: left unset. Pick one in **Settings**.
