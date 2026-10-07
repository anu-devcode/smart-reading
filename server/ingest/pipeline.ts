import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Ctx } from "../context.ts";
import type { DocKind, DocumentDto } from "../../shared/types.ts";
import { extractPdf, extractText, type Extracted } from "./extract.ts";
import { splitPassages } from "../text/passages.ts";
import { buildVocab, indexVariants } from "../text/dehyphen.ts";
import { reanchor } from "../text/anchor.ts";
import { getDocument, setDocumentFts } from "../library.ts";
import { spanText } from "../knowledge/highlights.ts";

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
  // Pages with no text of their own that were already read with OCR keep that text (and are not read again).
  const ocrRows = readOcrRows(ctx, docId);
  for (const p of ex.pages) {
    const o = ocrRows.get(p.page);
    if (p.status === "empty" && o?.status === "ok") {
      p.text = o.text;
      p.status = "ok";
      p.ocr = true;
    }
  }
  const { status, notes } = summarize(
    ctx,
    row.kind,
    ex.pages.map((p) => ({ page: p.page, status: p.status, ocr: !!p.ocr })),
    rejectedReasons(ocrRows),
  );

  const insertPage = ctx.db.prepare("INSERT INTO pages(doc_id, page, text, status, ocr) VALUES (?,?,?,?,?)");
  const insertPassage = ctx.db.prepare(
    "INSERT INTO passages(doc_id, page, ord, start, end, text) VALUES (?,?,?,?,?,?)",
  );
  const insertFts = ctx.db.prepare("INSERT INTO passages_fts(rowid, body, alt) VALUES (?,?,?)");
  const vocab = buildVocab(ex.pages.map((p) => p.text));

  const tx = ctx.db.transaction(() => {
    // clear any previous processing of this document (reprocess)
    ctx.db
      .prepare("DELETE FROM embeddings WHERE kind='passage' AND ref_id IN (SELECT id FROM passages WHERE doc_id = ?)")
      .run(docId);
    ctx.db.prepare("DELETE FROM passages_fts WHERE rowid IN (SELECT id FROM passages WHERE doc_id = ?)").run(docId);
    ctx.db.prepare("DELETE FROM passages WHERE doc_id = ?").run(docId);
    ctx.db.prepare("DELETE FROM pages WHERE doc_id = ?").run(docId);

    for (const p of ex.pages) {
      insertPage.run(docId, p.page, p.text, p.status, p.ocr ? 1 : 0);
      if (p.status === "empty") continue;
      splitPassages(p.text).forEach((s, ord) => {
        const text = p.text.slice(s.start, s.end);
        const info = insertPassage.run(docId, p.page, ord, s.start, s.end, text);
        const v = indexVariants(text, vocab);
        insertFts.run(Number(info.lastInsertRowid), v.body, v.alt);
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
  void ctx.ocrJob.kick(); // pages without text of their own are read in the background
}

// ---------- status and OCR bookkeeping ----------

interface OcrRow {
  status: "ok" | "rejected";
  reason: string | null;
  text: string;
}

function readOcrRows(ctx: Ctx, docId: number): Map<number, OcrRow> {
  const rows = ctx.db.prepare("SELECT page, status, reason, text FROM ocr_pages WHERE doc_id = ?").all(docId) as (OcrRow & { page: number })[];
  return new Map(rows.map((r) => [r.page, r]));
}

function rejectedReasons(rows: Map<number, OcrRow>): Map<number, string> {
  const m = new Map<number, string>();
  for (const [page, r] of rows) if (r.status === "rejected") m.set(page, r.reason ?? "it could not be read");
  return m;
}

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Ready / Partial / Failed for a document, with the reasons in plain words. */
export function summarize(
  ctx: Ctx,
  kind: DocKind,
  pages: { page: number; status: "ok" | "empty" | "garbled"; ocr: boolean }[],
  rejected: Map<number, string>,
): { status: DocumentDto["processingStatus"]; notes: string[] } {
  const ok = pages.filter((p) => p.status === "ok").length;
  const empty = pages.filter((p) => p.status === "empty").map((p) => p.page);
  const garbled = pages.filter((p) => p.status === "garbled").map((p) => p.page);
  const ocrPages = pages.filter((p) => p.ocr).map((p) => p.page);
  const notes: string[] = [];
  const failed = pages.length === 0 || ok === 0;

  if (failed) {
    notes.push(
      kind === "pdf"
        ? "No text could be extracted. This looks like a scanned or image-only PDF."
        : "This file has no text content.",
    );
  }

  // pages with no text of their own: read with OCR and rejected, or not read at all
  const byReason = new Map<string, number[]>();
  const unread: number[] = [];
  for (const n of empty) {
    const reason = rejected.get(n);
    if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), n]);
    else unread.push(n);
  }
  for (const [reason, list] of byReason) {
    notes.push(`OCR could not read ${plural(list.length, "page", "pages")} ${pageRanges(list)}: ${reason}. ${plural(list.length, "That page is", "Those pages are")} not searchable.`);
  }
  if (unread.length) {
    const where = `${plural(unread.length, "page", "pages")} ${pageRanges(unread)}`;
    if (kind !== "pdf") {
      notes.push(`No text on ${where}.`);
    } else if (!ctx.ocrJob.enabled()) {
      notes.push(`No extractable text on ${where}. ${plural(unread.length, "That page is", "Those pages are")} not searchable. Turn on OCR in Settings to read scanned pages.`);
    } else if (ctx.ocrJob.error) {
      notes.push(`No extractable text on ${where}. OCR could not run: ${ctx.ocrJob.error}`);
    } else {
      notes.push(`${plural(unread.length, "Page", "Pages")} ${pageRanges(unread)} ${plural(unread.length, "has", "have")} no text of ${plural(unread.length, "its", "their")} own and ${plural(unread.length, "is", "are")} waiting to be read with OCR.`);
    }
  }
  if (garbled.length) {
    notes.push(`Text on ${plural(garbled.length, "page", "pages")} ${pageRanges(garbled)} looks garbled and may search poorly.`);
  }
  if (ocrPages.length) {
    notes.push(`${plural(ocrPages.length, "Page", "Pages")} ${pageRanges(ocrPages)} ${plural(ocrPages.length, "was", "were")} read from the page image with OCR and may contain recognition mistakes. The page image is the source of truth.`);
  }
  const status = failed ? "failed" : empty.length || garbled.length ? "partial" : "ready";
  return { status, notes };
}

export function refreshDocumentStatus(ctx: Ctx, docId: number) {
  const doc = ctx.db.prepare("SELECT kind FROM documents WHERE id = ?").get(docId) as { kind: DocKind } | undefined;
  if (!doc) return;
  const pages = (
    ctx.db.prepare("SELECT page, status, ocr FROM pages WHERE doc_id = ? ORDER BY page").all(docId) as {
      page: number;
      status: "ok" | "empty" | "garbled";
      ocr: number;
    }[]
  ).map((p) => ({ page: p.page, status: p.status, ocr: p.ocr === 1 }));
  const { status, notes } = summarize(ctx, doc.kind, pages, rejectedReasons(readOcrRows(ctx, docId)));
  ctx.db.prepare("UPDATE documents SET processing_status=?, failure_notes=? WHERE id=?").run(status, JSON.stringify(notes), docId);
}

/**
 * Take one page's stored OCR result into the library: a page that was read becomes searchable text (marked as
 * OCR), a page that was rejected only has its reason recorded. Real extracted text is never overwritten.
 */
export function applyOcrPage(ctx: Ctx, docId: number, page: number) {
  const o = ctx.db.prepare("SELECT status, text FROM ocr_pages WHERE doc_id = ? AND page = ?").get(docId, page) as
    | { status: "ok" | "rejected"; text: string }
    | undefined;
  if (!o) return;
  let changed = false;
  ctx.db.transaction(() => {
    const cur = ctx.db.prepare("SELECT status FROM pages WHERE doc_id = ? AND page = ?").get(docId, page) as { status: string } | undefined;
    if (o.status === "ok" && cur?.status === "empty") {
      ctx.db.prepare("UPDATE pages SET text=?, status='ok', ocr=1 WHERE doc_id=? AND page=?").run(o.text, docId, page);
      const vocab = buildVocab((ctx.db.prepare("SELECT text FROM pages WHERE doc_id=? AND status='ok'").all(docId) as { text: string }[]).map((r) => r.text));
      const insertPassage = ctx.db.prepare("INSERT INTO passages(doc_id, page, ord, start, end, text) VALUES (?,?,?,?,?,?)");
      const insertFts = ctx.db.prepare("INSERT INTO passages_fts(rowid, body, alt) VALUES (?,?,?)");
      splitPassages(o.text).forEach((s, ord) => {
        const text = o.text.slice(s.start, s.end);
        const info = insertPassage.run(docId, page, ord, s.start, s.end, text);
        const v = indexVariants(text, vocab);
        insertFts.run(Number(info.lastInsertRowid), v.body, v.alt);
      });
      changed = true;
    }
    refreshDocumentStatus(ctx, docId);
  })();
  if (changed) {
    ctx.vectors.passage.invalidate();
    void ctx.embedJob.kick();
  }
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
    end_page: number | null;
    start: number;
    end: number;
    text: string;
    prefix: string;
    suffix: string;
  }[];
  for (const h of hls) {
    if (h.end_page !== null && h.end_page !== h.page) {
      // A span over several pages is kept only while its text is unchanged; otherwise it is marked stale.
      const same = spanText(ctx, docId, h.page, h.start, h.end_page, h.end) === h.text;
      ctx.db.prepare("UPDATE highlights SET stale=? WHERE id=?").run(same ? 0 : 1, h.id);
      continue;
    }
    const t = (pageText.get(docId, h.page) as { text: string } | undefined)?.text;
    const r = t ? reanchor(t, h) : null;
    if (r) ctx.db.prepare("UPDATE highlights SET start=?, end=?, stale=0 WHERE id=?").run(r.start, r.end, h.id);
    else ctx.db.prepare("UPDATE highlights SET stale=1 WHERE id=?").run(h.id);
  }

  const us = ctx.db.prepare("SELECT id, page, end_page, start, end, source_text FROM units WHERE doc_id=?").all(docId) as {
    id: number;
    page: number;
    end_page: number | null;
    start: number;
    end: number;
    source_text: string;
  }[];
  for (const u of us) {
    if (u.end_page !== null && u.end_page !== u.page) continue; // multi-page spans are not re-anchored
    const t = (pageText.get(docId, u.page) as { text: string } | undefined)?.text;
    const r = t ? reanchor(t, { text: u.source_text, prefix: "", suffix: "", start: u.start, end: u.end }) : null;
    if (r) {
      const p = passageAt.get(docId, u.page, r.start, r.start) as { id: number } | undefined;
      ctx.db.prepare("UPDATE units SET start=?, end=?, passage_id=? WHERE id=?").run(r.start, r.end, p?.id ?? null, u.id);
    }
  }
}
