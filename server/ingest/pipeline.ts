import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Ctx } from "../context.ts";
import type { DocKind, DocumentDto } from "../../shared/types.ts";
import { extractPdf, extractText, type Extracted } from "./extract.ts";
import { splitPassages } from "../text/passages.ts";
import { forIndex } from "../text/dehyphen.ts";
import { reanchor } from "../text/anchor.ts";
import { getDocument, setDocumentFts } from "../library.ts";

const KIND_BY_EXT: Record<string, DocKind> = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
};

export class UnsupportedFileError extends Error {}

export function kindFromName(name: string): DocKind {
  const k = KIND_BY_EXT[extname(name).toLowerCase()];
  if (!k) throw new UnsupportedFileError(`Unsupported file type: ${extname(name) || name}. Use PDF, Markdown or text.`);
  return k;
}

function safeName(name: string): string {
  return basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
}

function nameWithoutExt(name: string): string {
  const b = basename(name);
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
}

export interface ImportResult {
  document: DocumentDto;
  duplicate: boolean;
  /** resolves when text extraction and indexing for this document has finished */
  done: Promise<void>;
}

/** Copy the file into the library, create the row, and process it in the background. */
export function importFile(ctx: Ctx, input: { name: string; data: Buffer }): ImportResult {
  const kind = kindFromName(input.name);
  const hash = createHash("sha256").update(input.data).digest("hex");
  const existing = ctx.db.prepare("SELECT id FROM documents WHERE content_hash = ?").get(hash) as
    | { id: number }
    | undefined;
  if (existing) {
    return { document: getDocument(ctx, existing.id)!, duplicate: true, done: Promise.resolve() };
  }

  const stored = `${hash.slice(0, 10)}-${safeName(input.name)}`;
  writeFileSync(join(ctx.cfg.originalsDir, stored), input.data);
  const title = nameWithoutExt(input.name);
  const info = ctx.db
    .prepare(
      `INSERT INTO documents(title, kind, original_name, stored_name, size, content_hash, added_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(title, kind, safeName(input.name), stored, input.data.length, hash, new Date().toISOString());
  const id = Number(info.lastInsertRowid);
  setDocumentFts(ctx, id, title, null);

  const done = processDocument(ctx, id, { firstTime: true }).catch(() => undefined);
  ctx.inflight.add(done);
  void done.finally(() => ctx.inflight.delete(done));
  return { document: getDocument(ctx, id)!, duplicate: false, done };
}

function pageRanges(nums: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

function guessTitle(ex: Extracted, fallback: string): string {
  if (ex.title) return ex.title;
  const first = ex.pages.find((p) => p.status === "ok")?.text.split(/\n\n/)[0]?.trim();
  if (first && first.length <= 90 && first.split(/\s+/).length >= 2 && !/[.!?]$/.test(first)) return first;
  return fallback;
}

export async function processDocument(ctx: Ctx, docId: number, opts: { firstTime: boolean }): Promise<void> {
  const row = ctx.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as
    | { kind: DocKind; stored_name: string; title: string; original_name: string }
    | undefined;
  if (!row) return;
  const file = join(ctx.cfg.originalsDir, row.stored_name);

  let extracted: Extracted | null = null;
  let failure: string | null = null;
  try {
    if (!existsSync(file)) throw new Error("The stored file is missing from the library folder.");
    if (row.kind === "pdf") extracted = await extractPdf(new Uint8Array(readFileSync(file)));
    else extracted = extractText(readFileSync(file, "utf8"), row.kind);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (!extracted) {
    ctx.db
      .prepare("UPDATE documents SET processing_status='failed', failure_notes=? WHERE id=?")
      .run(JSON.stringify([`Could not read this file: ${failure}`]), docId);
    return;
  }

  const ex = extracted;
  const okPages = ex.pages.filter((p) => p.status === "ok").length;
  const emptyPages = ex.pages.filter((p) => p.status === "empty").map((p) => p.page);
  const garbledPages = ex.pages.filter((p) => p.status === "garbled").map((p) => p.page);
  const notes: string[] = [];
  let status: DocumentDto["processingStatus"];
  if (ex.pages.length === 0 || okPages === 0) {
    status = "failed";
    notes.push(
      row.kind === "pdf"
        ? "No text could be extracted. This looks like a scanned or image-only PDF. It cannot be searched (OCR is not supported yet)."
        : "This file has no text content.",
    );
  } else {
    status = emptyPages.length || garbledPages.length ? "partial" : "ready";
    if (emptyPages.length) {
      notes.push(`No extractable text on page${emptyPages.length > 1 ? "s" : ""} ${pageRanges(emptyPages)}. Those pages are not searchable.`);
    }
    if (garbledPages.length) {
      notes.push(`Text on page${garbledPages.length > 1 ? "s" : ""} ${pageRanges(garbledPages)} looks garbled and may search poorly.`);
    }
  }

  const insertPage = ctx.db.prepare("INSERT INTO pages(doc_id, page, text, status) VALUES (?,?,?,?)");
  const insertPassage = ctx.db.prepare(
    "INSERT INTO passages(doc_id, page, ord, start, end, text) VALUES (?,?,?,?,?,?)",
  );
  const insertFts = ctx.db.prepare("INSERT INTO passages_fts(rowid, body) VALUES (?,?)");

  const tx = ctx.db.transaction(() => {
    // clear any previous processing of this document (reprocess)
    ctx.db
      .prepare("DELETE FROM embeddings WHERE kind='passage' AND ref_id IN (SELECT id FROM passages WHERE doc_id = ?)")
      .run(docId);
    ctx.db.prepare("DELETE FROM passages_fts WHERE rowid IN (SELECT id FROM passages WHERE doc_id = ?)").run(docId);
    ctx.db.prepare("DELETE FROM passages WHERE doc_id = ?").run(docId);
    ctx.db.prepare("DELETE FROM pages WHERE doc_id = ?").run(docId);

    for (const p of ex.pages) {
      insertPage.run(docId, p.page, p.text, p.status);
      if (p.status === "empty") continue;
      splitPassages(p.text).forEach((s, ord) => {
        const text = p.text.slice(s.start, s.end);
        const info = insertPassage.run(docId, p.page, ord, s.start, s.end, text);
        insertFts.run(Number(info.lastInsertRowid), forIndex(text));
      });
    }

    if (opts.firstTime) {
      const title = guessTitle(ex, row.title);
      ctx.db
        .prepare("UPDATE documents SET title=?, author=?, year=? WHERE id=?")
        .run(title, ex.author, ex.year, docId);
      setDocumentFts(ctx, docId, title, ex.author);
    }
    ctx.db
      .prepare("UPDATE documents SET processing_status=?, failure_notes=?, page_count=? WHERE id=?")
      .run(status, JSON.stringify(notes), ex.pages.length, docId);

    if (!opts.firstTime) reanchorAll(ctx, docId);
  });
  tx();
  ctx.vectors.passage.invalidate();
  void ctx.embedJob.kick();
}

/** Re-extract a document (e.g. after an extractor improvement) and re-anchor highlights and units. */
export async function reprocessDocument(ctx: Ctx, docId: number): Promise<void> {
  await processDocument(ctx, docId, { firstTime: false });
}

function reanchorAll(ctx: Ctx, docId: number) {
  const pageText = ctx.db.prepare("SELECT text FROM pages WHERE doc_id=? AND page=?");
  const passageAt = ctx.db.prepare(
    "SELECT id FROM passages WHERE doc_id=? AND page=? AND start<=? AND end>? ORDER BY start LIMIT 1",
  );

  const hls = ctx.db.prepare("SELECT * FROM highlights WHERE doc_id=?").all(docId) as {
    id: number;
    page: number;
    start: number;
    end: number;
    text: string;
    prefix: string;
    suffix: string;
  }[];
  for (const h of hls) {
    const t = (pageText.get(docId, h.page) as { text: string } | undefined)?.text;
    const r = t ? reanchor(t, h) : null;
    if (r) ctx.db.prepare("UPDATE highlights SET start=?, end=?, stale=0 WHERE id=?").run(r.start, r.end, h.id);
    else ctx.db.prepare("UPDATE highlights SET stale=1 WHERE id=?").run(h.id);
  }

  const us = ctx.db.prepare("SELECT id, page, start, end, source_text FROM units WHERE doc_id=?").all(docId) as {
    id: number;
    page: number;
    start: number;
    end: number;
    source_text: string;
  }[];
  for (const u of us) {
    const t = (pageText.get(docId, u.page) as { text: string } | undefined)?.text;
    const r = t ? reanchor(t, { text: u.source_text, prefix: "", suffix: "", start: u.start, end: u.end }) : null;
    if (r) {
      const p = passageAt.get(docId, u.page, r.start, r.start) as { id: number } | undefined;
      ctx.db.prepare("UPDATE units SET start=?, end=?, passage_id=? WHERE id=?").run(r.start, r.end, p?.id ?? null, u.id);
    }
  }
}
