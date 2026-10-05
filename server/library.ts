import type { Ctx } from "./context.ts";
import type { DocumentDto, ReadingStatus, PageDto } from "../shared/types.ts";
import { READING_STATUSES } from "../shared/types.ts";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

interface DocRow {
  id: number;
  title: string;
  author: string | null;
  year: number | null;
  kind: DocumentDto["kind"];
  original_name: string;
  page_count: number;
  processing_status: DocumentDto["processingStatus"];
  reading_status: ReadingStatus;
  failure_notes: string;
  added_at: string;
}

export function toDocumentDto(row: DocRow, unitCount: number, embeddingPending: boolean): DocumentDto {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    kind: row.kind,
    originalName: row.original_name,
    pageCount: row.page_count,
    processingStatus: row.processing_status,
    readingStatus: row.reading_status,
    failureNotes: JSON.parse(row.failure_notes) as string[],
    addedAt: row.added_at,
    unitCount,
    embeddingPending,
  };
}

export function listDocuments(ctx: Ctx): DocumentDto[] {
  const rows = ctx.db.prepare("SELECT * FROM documents ORDER BY added_at DESC, id DESC").all() as DocRow[];
  const counts = new Map(
    (ctx.db.prepare("SELECT doc_id d, COUNT(*) c FROM units GROUP BY doc_id").all() as { d: number; c: number }[]).map(
      (r) => [r.d, r.c],
    ),
  );
  const pending = ctx.embedJob.pendingDocIds();
  return rows.map((r) => toDocumentDto(r, counts.get(r.id) ?? 0, pending.has(r.id)));
}

export function getDocument(ctx: Ctx, id: number): DocumentDto | null {
  const row = ctx.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocRow | undefined;
  if (!row) return null;
  const c = ctx.db.prepare("SELECT COUNT(*) c FROM units WHERE doc_id = ?").get(id) as { c: number };
  return toDocumentDto(row, c.c, ctx.embedJob.pendingDocIds().has(id));
}

export function getPages(ctx: Ctx, docId: number): PageDto[] {
  return ctx.db
    .prepare("SELECT page, text, status FROM pages WHERE doc_id = ? ORDER BY page")
    .all(docId) as PageDto[];
}

export function getPageText(ctx: Ctx, docId: number, page: number): string | null {
  const r = ctx.db.prepare("SELECT text FROM pages WHERE doc_id = ? AND page = ?").get(docId, page) as
    | { text: string }
    | undefined;
  return r ? r.text : null;
}

export function setDocumentFts(ctx: Ctx, id: number, title: string, author: string | null) {
  ctx.db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(id);
  ctx.db.prepare("INSERT INTO documents_fts(rowid, title, author) VALUES (?,?,?)").run(id, title, author ?? "");
}

export function patchDocument(
  ctx: Ctx,
  id: number,
  patch: { title?: string; author?: string | null; year?: number | null; readingStatus?: ReadingStatus },
): DocumentDto | null {
  const cur = ctx.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocRow | undefined;
  if (!cur) return null;
  const title = patch.title !== undefined && patch.title.trim() ? patch.title.trim() : cur.title;
  const author = patch.author !== undefined ? (patch.author?.trim() || null) : cur.author;
  const year = patch.year !== undefined ? patch.year : cur.year;
  let reading = cur.reading_status;
  if (patch.readingStatus !== undefined) {
    if (!READING_STATUSES.includes(patch.readingStatus)) throw new Error("invalid reading status");
    reading = patch.readingStatus;
  }
  ctx.db
    .prepare("UPDATE documents SET title=?, author=?, year=?, reading_status=? WHERE id=?")
    .run(title, author, year, reading, id);
  setDocumentFts(ctx, id, title, author);
  return getDocument(ctx, id);
}

/**
 * Delete a document. Accepted knowledge is the user's, so we refuse to delete a document that has
 * units unless the caller explicitly confirms removing them too.
 */
export function deleteDocument(ctx: Ctx, id: number, force: boolean): { ok: boolean; unitCount: number } {
  const row = ctx.db.prepare("SELECT stored_name FROM documents WHERE id = ?").get(id) as
    | { stored_name: string }
    | undefined;
  if (!row) return { ok: false, unitCount: 0 };
  const unitCount = (ctx.db.prepare("SELECT COUNT(*) c FROM units WHERE doc_id = ?").get(id) as { c: number }).c;
  if (unitCount > 0 && !force) return { ok: false, unitCount };

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "DELETE FROM embeddings WHERE kind='passage' AND ref_id IN (SELECT id FROM passages WHERE doc_id = ?)",
      )
      .run(id);
    ctx.db.prepare("DELETE FROM passages_fts WHERE rowid IN (SELECT id FROM passages WHERE doc_id = ?)").run(id);
    ctx.db
      .prepare("DELETE FROM embeddings WHERE kind='unit' AND ref_id IN (SELECT id FROM units WHERE doc_id = ?)")
      .run(id);
    ctx.db.prepare("DELETE FROM units_fts WHERE rowid IN (SELECT id FROM units WHERE doc_id = ?)").run(id);
    ctx.db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(id);
    ctx.db.prepare("DELETE FROM documents WHERE id = ?").run(id); // cascades pages, passages, highlights, units
  });
  tx();
  ctx.vectors.passage.invalidate();
  ctx.vectors.unit.invalidate();
  const file = join(ctx.cfg.originalsDir, row.stored_name);
  if (existsSync(file)) unlinkSync(file);
  return { ok: true, unitCount };
}
