import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionDto, DocumentDto, ReadingStatus } from "../../../shared/types";
import { READING_STATUSES } from "../../../shared/types";
import { api } from "../api";
import { Empty, ErrorState, Loading, PageHeader, ProcessingChip, READING_LABEL, useToast } from "../components";
import { href } from "../router";

/** New files wait here while they are read, and stay here if they need attention. */
const inInbox = (d: DocumentDto) => d.processingStatus === "processing" || d.processingStatus === "failed" || d.ocrPending > 0;

export function LibraryPage() {
  const toast = useToast();
  const [docs, setDocs] = useState<DocumentDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setDocs(await api.documents());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    api.collections().then(setCollections).catch(() => undefined);
  }, [load]);

  // poll while anything is still being processed or indexed
  const busy = docs?.some((d) => d.processingStatus === "processing" || d.embeddingPending || d.ocrPending > 0) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [busy, load]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const results = await api.upload(files);
      const dupes = results.filter((r) => r.duplicate).length;
      const errors = results.filter((r) => r.error);
      const added = results.filter((r) => r.document && !r.duplicate).length;
      if (added) toast(`Added ${added} file${added > 1 ? "s" : ""}. Indexing in the background.`);
      if (dupes) toast(`${dupes} file${dupes > 1 ? "s were" : " was"} already in your library.`);
      errors.forEach((r) => toast(`${r.name}: ${r.error}`, "error"));
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (d: DocumentDto) => {
    if (!confirm(`Remove "${d.title}" from your library?`)) return;
    try {
      await api.deleteDocument(d.id);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409 && confirm(`${err.message}\n\nDelete the document and its saved knowledge?`)) {
        await api.deleteDocument(d.id, true).catch((x) => toast((x as Error).message, "error"));
      } else if (err.status !== 409) toast(err.message, "error");
    }
    await load();
  };

  const editMeta = async (d: DocumentDto) => {
    const title = prompt("Title", d.title);
    if (title === null) return;
    const author = prompt("Author (optional)", d.author ?? "");
    if (author === null) return;
    try {
      await api.patchDocument(d.id, { title, author: author || null });
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const setReading = async (d: DocumentDto, s: ReadingStatus) => {
    await api.patchDocument(d.id, { readingStatus: s }).catch((e) => toast((e as Error).message, "error"));
    await load();
  };

  const choose = () => fileInput.current?.click();
  const shown = (docs ?? []).filter((d) => {
    const f = filter.trim().toLowerCase();
    return !f || `${d.title} ${d.author ?? ""}`.toLowerCase().includes(f);
  });
  const inbox = shown.filter(inInbox);
  const shelf = shown.filter((d) => !inInbox(d));
  const countOf = (s: ReadingStatus) => (docs ?? []).filter((d) => d.readingStatus === s).length;

  const row = (d: DocumentDto) => (
    <li key={d.id} className={`doc doc-${d.kind}`}>
      <span className="doc-kind" aria-hidden="true">
        {d.kind === "markdown" ? "MD" : d.kind === "text" ? "TXT" : "PDF"}
      </span>
      <div className="doc-main">
        <a
          className="doc-title"
          href={href(`reader/${d.id}`)}
          onClick={(e) => d.processingStatus === "failed" && (e.preventDefault(), toast("This document has no readable text. See the note below.", "error"))}
        >
          {d.title}
        </a>
        <div className="muted small">
          {[d.author, d.year, d.pageCount ? `${d.pageCount} page${d.pageCount > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}
          {d.unitCount > 0 && (
            <>
              {d.author || d.year || d.pageCount ? " · " : ""}
              <a href={href("knowledge", { docId: d.id })}>{d.unitCount} kept</a>
            </>
          )}
        </div>
        {d.failureNotes.map((n, i) => (
          <div key={i} className={`note ${d.processingStatus === "failed" ? "bad" : "warn"}`}>
            {n}
          </div>
        ))}
      </div>
      <div className="doc-side">
        <ProcessingChip status={d.processingStatus} />
        {d.embeddingPending && d.processingStatus !== "processing" && (
          <span className="muted small" title="Searching by words works now; search by meaning is still preparing this document">
            preparing search…
          </span>
        )}
        <select value={d.readingStatus} onChange={(e) => void setReading(d, e.target.value as ReadingStatus)} aria-label={`Reading status of ${d.title}`}>
          {READING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {READING_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="doc-actions">
          <button className="link" onClick={() => void editMeta(d)} aria-label={`Edit details of ${d.title}`}>
            Edit
          </button>
          <button className="link danger" onClick={() => void remove(d)} aria-label={`Remove ${d.title}`}>
            Remove
          </button>
        </span>
      </div>
    </li>
  );

  return (
    <div
      className={`page library ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      <aside className="side" aria-label="Views and collections">
        <h3>Views</h3>
        <ul className="plain side-list">
          {(["unread", "reading", "revisit"] as const).map((s) => (
            <li key={s}>
              <a href={href("search", { q: `status:${s}` })}>
                <span>{READING_LABEL[s]}</span>
                {docs && <span className="count">{countOf(s)}</span>}
              </a>
            </li>
          ))}
        </ul>
        <h3>Collections</h3>
        {collections.length === 0 && <p className="muted small">Save a search to create a collection: a view, not a folder.</p>}
        <ul className="plain side-list">
          {collections.map((c) => (
            <li key={c.id} className="row between">
              <a href={href("search", { q: c.query })} title={c.query}>
                <span>{c.name}</span>
              </a>
              <button
                className="link small"
                title="Remove collection"
                aria-label={`Remove collection ${c.name}`}
                onClick={async () => {
                  await api.deleteCollection(c.id);
                  setCollections(await api.collections());
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="main">
        <PageHeader
          eyebrow="Library"
          title={
            <>
              Your library {docs && docs.length > 0 && <span className="count-big">{docs.length}</span>}
            </>
          }
          actions={
            <button className="primary" onClick={choose} disabled={uploading}>
              {uploading ? "Adding…" : "Add files"}
            </button>
          }
        >
          Everything you read, ready to open. No folders to choose.
        </PageHeader>

        <div
          className="dropzone"
          onClick={choose}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose())}
          role="button"
          tabIndex={0}
          aria-label="Add files: drop PDFs, Markdown or text files here, or press Enter to choose"
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.md,.markdown,.txt,.text"
            hidden
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <strong>{uploading ? "Adding your files…" : dragging ? "Drop to add to your library" : "Drop PDFs, Markdown or text files here"}</strong>
          <span className="muted"> or click to choose. Files are only read and indexed; nothing is written for you.</span>
        </div>

        {loadError && <ErrorState message={loadError} onRetry={() => void load()} />}
        {!loadError && docs === null && <Loading label="Loading your library…" />}
        {docs && docs.length === 0 && (
          <Empty title="Your library is empty" action={<button className="primary" onClick={choose}>Add your first file</button>}>
            Add a PDF, a Markdown file or a text file. It appears here, ready to read, in a few seconds.
          </Empty>
        )}

        {docs && docs.length > 0 && (
          <>
            <div className="list-head">
              <input className="filter" type="search" placeholder="Filter by title or author" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter documents" />
            </div>

            {inbox.length > 0 && (
              <section className="group" aria-labelledby="inbox-title">
                <h2 id="inbox-title" className="group-title">
                  Inbox <span className="count">{inbox.length}</span>
                </h2>
                <p className="muted small group-desc">New files wait here while they are being read. Anything that needs your attention stays here with the reason.</p>
                <ul className="doclist">{inbox.map(row)}</ul>
              </section>
            )}

            {shelf.length > 0 && (
              <section className="group" aria-labelledby={inbox.length > 0 ? "shelf-title" : undefined}>
                {inbox.length > 0 && (
                  <h2 id="shelf-title" className="group-title">
                    On your shelf <span className="count">{shelf.length}</span>
                  </h2>
                )}
                <ul className="doclist">{shelf.map(row)}</ul>
              </section>
            )}

            {shown.length === 0 && (
              <Empty title="No documents match" action={<button onClick={() => setFilter("")}>Clear filter</button>}>
                Nothing in your library has “{filter}” in its title or author.
              </Empty>
            )}
          </>
        )}
      </section>
    </div>
  );
}
