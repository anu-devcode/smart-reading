import type { Ctx } from "../context.ts";
import type { HighlightDto } from "../../shared/types.ts";
import { findSpan, makeAnchor } from "../text/anchor.ts";
import { getPageText } from "../library.ts";
import { badRequest, notFound } from "../errors.ts";

interface HlRow {
  id: number;
  doc_id: number;
  page: number;
  start: number;
  end: number;
  text: string;
  note: string | null;
  stale: number;
}

const toDto = (r: HlRow): HighlightDto => ({
  id: r.id,
  docId: r.doc_id,
  page: r.page,
  start: r.start,
  end: r.end,
  text: r.text,
  note: r.note,
  stale: !!r.stale,
});

/** Resolve a selection copied from the reader into an exact span of the stored page text. */
export function resolveSelection(ctx: Ctx, docId: number, page: number, selection: string, hint?: number) {
  const text = getPageText(ctx, docId, page);
  if (text === null) throw notFound("That page does not exist in this document.");
  const span = findSpan(text, selection, hint);
  if (!span) {
    throw badRequest(
      "Could not match that selection to the document text. Try selecting a shorter span within one page.",
    );
  }
  return { pageText: text, span };
}

export function createHighlight(
  ctx: Ctx,
  input: { docId: number; page: number; selectionText: string; hint?: number; note?: string | null },
): HighlightDto {
  const { pageText, span } = resolveSelection(ctx, input.docId, input.page, input.selectionText, input.hint);
  const existing = ctx.db
    .prepare("SELECT * FROM highlights WHERE doc_id=? AND page=? AND start=? AND end=?")
    .get(input.docId, input.page, span.start, span.end) as HlRow | undefined;
  if (existing) {
    if (input.note !== undefined) {
      ctx.db.prepare("UPDATE highlights SET note=? WHERE id=?").run(input.note?.trim() || null, existing.id);
    }
    return toDto(ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(existing.id) as HlRow);
  }
  const a = makeAnchor(pageText, span.start, span.end);
  const info = ctx.db
    .prepare(
      `INSERT INTO highlights(doc_id, page, start, end, text, prefix, suffix, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(input.docId, input.page, a.start, a.end, a.text, a.prefix, a.suffix, input.note?.trim() || null, new Date().toISOString());
  return toDto(ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(Number(info.lastInsertRowid)) as HlRow);
}

export function listHighlights(ctx: Ctx, docId: number): HighlightDto[] {
  return (ctx.db.prepare("SELECT * FROM highlights WHERE doc_id=? ORDER BY page, start").all(docId) as HlRow[]).map(toDto);
}

export function updateHighlight(ctx: Ctx, id: number, note: string | null): HighlightDto {
  const r = ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(id) as HlRow | undefined;
  if (!r) throw notFound("Highlight not found");
  ctx.db.prepare("UPDATE highlights SET note=? WHERE id=?").run(note?.trim() || null, id);
  return toDto(ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(id) as HlRow);
}

export function deleteHighlight(ctx: Ctx, id: number): void {
  ctx.db.prepare("DELETE FROM highlights WHERE id=?").run(id);
}
