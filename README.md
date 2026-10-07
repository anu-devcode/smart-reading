# Anbabi

A local-first place to read, search and keep what you learn.

> Index everything. Make knowledge durable only when you accept it. Keep every idea traceable to its source.

- **Library**: drop in PDFs, Markdown or text files. They are read and indexed. Nothing is generated on upload.
- **Search**: one box. Exact phrases, `AND` / `OR` / `NOT`, `title:` / `author:` / `note:`, filters (`type:idea`, `status:unread`, `kind:pdf`) and meaning search (describe an idea in your own words). Every hit shows the page and why it matched.
- **Reader**: read the PDF inside the app, select text (up to 5 pages at once), then **Highlight**, **Keep as Quote**, **Write idea…** or **Distill**. A **Contents** menu jumps to the PDF's bookmarks or the Markdown headings.
- **Knowledge**: what you accepted, as Quote / Idea / Concept / Question. Each one is tied to an exact span of its source. You can link two units as *same idea*, *supports* or *contradicts*.
- **Distill** (optional): an AI proposes up to 3 candidates from your selection. They are never saved unless you accept them, and any candidate whose supporting quote is not found verbatim in your selection is dropped (the panel says how many).
- **Reuse**: **Copy with citation** on any unit copies it with its source: `“quote” — Author, Title (Year), p. N`.
- **Scanned pages**: pages with no text layer are read with OCR, locally. Their text is selectable and quotable like any other page.

### The five places

| Place | What it is for | Where it lives |
| --- | --- | --- |
| Inbox | files arrive and the system reads them; you never file anything | the Library drop zone and each document's status (Processing, Reading scanned pages…, Partial, Failed with the reason) |
| Library | what you have, and where you are in it | Library, with the Unread / Reading / To revisit views and saved searches as collections |
| Reader | reading, and the only place where knowledge is created | Reader |
| Search | finding again, units first, always with the reason | Search |
| Workshop | working with what you accepted: edit, link, export | Knowledge |

## Run it

Requires Node 22+ (developed on 24).

```
npm install
npm start          # builds the UI, then serves http://localhost:4177
```

For development with hot reload: `npm run dev` (UI on http://localhost:5173, API on 4177).

The first time you open it, you create the **owner account**. If a library already exists from before accounts, it becomes the owner's, unchanged.

Your data lives in `library-data/` (override with `LIBRARY_DIR`):

- `accounts.db`: usernames, password hashes (scrypt) and sign-in sessions. No reading data.
- `users/<id>/`: one library per account, with its own SQLite database, original files, settings and exports.
- `models/`: the meaning-search model and OCR language data, shared by everyone.

## Accounts

- **Each person has their own library.** Separate folders and separate databases, so there is no query that could show one person's documents or notes to another.
- **The owner adds people** in **Settings → People** and gives them a starting password. There is no sign-up page. The owner can set a new password for someone (this signs them out everywhere) or remove them, which deletes their whole library after typing their name to confirm.
- **Everyone** can change their own password in **Settings** (other devices are then signed out) and sets their own Distill provider and OCR language.
- **Sign-in**: sessions last 30 days from last use, in an `HttpOnly`, `SameSite=Strict` cookie; the database stores only a hash of each session token. After 5 wrong passwords for a name from one address, sign-in waits 30 seconds, doubling up to 15 minutes. Writes sent from another website are refused.
- **No accounts, on this computer only**: `ACCOUNTS=off` keeps the old single library directly in `library-data/` with no sign-in, and refuses to start on any address other than this computer's. Once an owner account has adopted that library it lives in `users/1/`, so set `LIBRARY_DIR` to that folder if you go back.

### Using it from other devices

By default the server only listens on this computer. To reach it from a phone or another computer on your network:

```
HOST=0.0.0.0 npm start
```

Then open `http://<this computer's address>:4177`. **Over plain HTTP, passwords and pages cross the network unencrypted**, so on anything but a home network you trust, put HTTPS in front:

- a reverse proxy such as [Caddy](https://caddyserver.com/) (`reverse_proxy 127.0.0.1:4177`) with `TRUST_PROXY=1`, so the app sees the real protocol and marks the cookie `Secure`; or
- a private network such as [Tailscale](https://tailscale.com/), which encrypts the traffic between your devices.

The first run downloads the meaning-search model (about 130 MB, once). Until it is ready, search works with keywords only and the header says so.

The first scanned page downloads the OCR language data (about 5 MB per language, once, into `library-data/models/tesseract`). OCR runs in the background, about a second per page; the document shows "Reading N scanned pages with OCR…" until it is done.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBRARY_DIR` | `library-data` | where everything is stored |
| `PORT` | `4177` | port to listen on |
| `HOST` | `127.0.0.1` | `0.0.0.0` makes it reachable from other devices (see above) |
| `ACCOUNTS` | `on` | `off`: one library, no sign-in, this computer only |
| `TRUST_PROXY` | off | `1` behind an HTTPS reverse proxy |
| `EMBEDDINGS` | `on` | `off` disables meaning search (keywords only) |
| `EMBED_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | any compatible sentence-embedding model |
| `SEMANTIC_MIN` | `0.4` | minimum similarity for a meaning-only hit |
| `OCR` | `on` | `off` never reads scanned pages (they stay unsearchable, with the reason) |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | none | provider for Distill (can also be set in **Settings**) |

**OCR** can also be turned on or off in **Settings**, with its language: a Tesseract code such as `eng`, `fra`, `deu`, or several joined with `+` (`eng+fra`). Changing the language re-reads scanned pages that have not been read in that language yet.

**Distill provider.** Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, or a local one such as Ollama (`http://localhost:11434/v1`, any API key). Each account sets its own; the key is stored in that account's `settings.json`, never sent anywhere except to the URL you set, and blanked in backups. Without a provider, everything else still works.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | unit and integration tests |
| `npm run eval` | acceptance gates on a fixed set of PDFs and queries, using the real model |
| `npm run embeddings:rebuild` | rebuild all meaning vectors (needed after changing `EMBED_MODEL`) |
| `npm run export [-- --user <name>]` | write a portable `library.json` + `knowledge.md` (units with their source, page and text) into each library's `exports/` folder; every account unless `--user` is given |
| `npm run backup -- create [dir]` | consistent copy of the accounts and every library (databases and originals) |
| `npm run backup -- restore <dir> [--force]` | restore into `LIBRARY_DIR` (stop the app first); everyone signs in again. A backup of a single library can be restored into one account with `--user <name>` |

Embeddings are derived data. Your knowledge (units, highlights, links) never depends on a model, so changing models is a rebuild, not a migration.

## How it works

- **Ingest**: pdf.js extracts text per page. Each page is marked `ok`, `empty` or `garbled`. A document is **Ready**, **Partial** (some pages unreadable, listed) or **Failed** (nothing readable). Text is split into passages of at most 90 words, never crossing a page.
- **Columns**: column gutters are detected from where text is absent across many rows. On a multi-column page each column is read top to bottom before the next; full-width headings split the page into blocks. Single-column pages are read as before.
- **Line-end hyphens**: "inter- national" is decided per word from the document itself. If the document also has "well-known" typed with a hyphen, it is a compound; if it has "international" as one word, or there is no evidence, it is rejoined. Both readings stay searchable, and the stored text and your quotes keep the original characters.
- **OCR**: only pages with no extractable text are OCR'd; real text is never replaced. Words recognised with low confidence are dropped, and a page whose overall confidence is too low, or that contains no text (a drawing), is rejected with the reason instead of guessed at. Pages read with OCR are labelled in the reader and in the document notes. Results are kept, so re-processing a file does not OCR it again.
- **Anchoring**: a quote is always an exact slice of the page text (or of consecutive pages joined by a blank line), so it is an exact substring of the source by construction. If a file is re-processed, units are re-anchored by their surrounding text, and shown as *stale* if they cannot be found.
- **Search**: SQLite FTS5 (BM25, stemming, accent folding) plus local embeddings (brute-force cosine), merged with reciprocal rank fusion. Queries with quotes or operators put exact matches first.
- **Safety**: a document that has saved units cannot be removed without an explicit confirmation.

### Search guardrails

These keep meaning search from turning into a black box:

1. **Embeddings are derived.** They can be deleted and rebuilt (`npm run embeddings:rebuild`) at any time; exports and backups of your knowledge never depend on them.
2. **One merge, no knobs.** Keyword and meaning results are combined by a single reciprocal rank fusion. There is no learned ranking and no per-query tuning; the only setting is the minimum similarity for a meaning-only hit.
3. **Exact stays exact.** Quoted phrases, `AND` / `OR` / `NOT` and field queries always list exact matches first; meaning matches can only fill in below them. `NOT` queries use keywords only.
4. **Every result says why.** Each hit shows the words it matched, or "similar meaning" with its score, and the passage it came from. A result that cannot show its evidence is not shown.

## Known limits

- **OCR can misread.** The page image is the source of truth; OCR pages say so.
- **Tables** are read column by column, not row by row.
- A selection or quote can span at most 5 pages. If a file is re-processed and its text changed, a multi-page highlight is marked *stale*, and a multi-page unit keeps its saved text but is not moved to the new position.
- Passages (the units of search) never cross a page, so a sentence broken across pages is found through either half.
- **No sharing between accounts.** Each library is private; there is no way to share a document or a unit with another person.
- **One owner.** The first account manages the others; ownership cannot be handed over in the app.
- **No HTTPS built in.** Use a reverse proxy or a private network when the server is reachable from other devices.
- **No offline sync.** Devices use the one server; nothing is stored on a phone or laptop.

## Assumptions to confirm

These were open questions; the defaults below keep the choice reversible.

1. **Languages**: the default model is multilingual, so non-English documents work. If you only read English, a smaller English model could be faster. Change `EMBED_MODEL` and run `npm run embeddings:rebuild`.
2. **AI provider for Distill**: left unset. Pick one in **Settings**.
