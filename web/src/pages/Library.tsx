import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionDto, DocumentDto, ReadingStatus } from "../../../shared/types";
import { READING_STATUSES } from "../../../shared/types";
import { api } from "../api";
import { Empty, ProcessingChip, useToast } from "../components";
import { href } from "../router";

const READING_LABEL: Record<ReadingStatus, string> = {
  unread: "Unread",
  reading: "Reading",
  finished: "Finished",
  revisit: "Revisit",
};

export function LibraryPage() {
  const toast = useToast();
  const [docs, setDocs] = useState<DocumentDto[] | null>(null);
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setDocs(await api.documents());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
    api.collections().then(setCollections).catch(() => undefined);
  }, [load]);

  // poll while anything is still being processed or indexed
  const busy = docs?.some((d) => d.processingStatus === "processing" || d.embeddingPending) ?? false;
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

  const shown = (docs ?? []).filter((d) => {
    const f = filter.trim().toLowerCase();
    return !f || `${d.title} ${d.author ?? ""}`.toLowerCase().includes(f);
  });

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
      <aside className="side">
        <h3>Collections</h3>
        {collections.length === 0 && <p className="muted small">Save a search to create a collection: a view, not a folder.</p>}
        <ul className="plain">
          {collections.map((c) => (
            <li key={c.id} className="row between">
              <a href={href("search", { q: c.query })} title={c.query}>
                {c.name}
              </a>
              <button
                className="link small"
                title="Remove collection"
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
        <h3>Views</h3>
        <ul className="plain">
          <li>
            <a href={href("search", { q: "status:unread" })}>Unread</a>
          </li>
          <li>
            <a href={href("search", { q: "status:reading" })}>Reading</a>
          </li>
          <li>
            <a href={href("search", { q: "status:revisit" })}>To revisit</a>
          </li>
        </ul>
      </aside>

      <section className="main">
        <div className="dropzone" onClick={() => fileInput.current?.click()} role="button" tabIndex={0}>
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
          <strong>{uploading ? "Uploading…" : "Drop PDFs, Markdown or text files here"}</strong>
          <span className="muted"> or click to choose. Nothing is generated on upload: files are only read and indexed.</span>
        </div>

        <div className="row between" style={{ margin: "16px 0 8px" }}>
          <h2 style={{ margin: 0 }}>Library {docs && <span className="muted small">({docs.length})</span>}</h2>
          <input
            className="filter"
            placeholder="Filter by title or author"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {docs === null && <Empty>Loading…</Empty>}
        {docs && docs.length === 0 && <Empty>Your library is empty. Add a file to start reading.</Empty>}

        <ul className="doclist">
          {shown.map((d) => (
            <li key={d.id} className="doc">
              <div className="doc-main">
                <a className="doc-title" href={href(`reader/${d.id}`)} onClick={(e) => d.processingStatus === "failed" && (e.preventDefault(), toast("This document has no readable text. See the note below.", "error"))}>
                  {d.title}
                </a>
                <div className="muted small">
                  {[d.author, d.year, d.kind.toUpperCase(), d.pageCount ? `${d.pageCount} page${d.pageCount > 1 ? "s" : ""}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                  {d.unitCount > 0 && (
                    <>
                      {" · "}
                      <a href={href("knowledge", { docId: d.id })}>{d.unitCount} saved</a>
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
                  <span className="muted small" title="Keyword search works now; meaning search is still indexing this document">
                    indexing…
                  </span>
                )}
                <select
                  value={d.readingStatus}
                  onChange={(e) => void setReading(d, e.target.value as ReadingStatus)}
                  aria-label="Reading status"
                >
                  {READING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {READING_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button className="link" onClick={() => void editMeta(d)}>
                  Edit
                </button>
                <button className="link danger" onClick={() => void remove(d)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
