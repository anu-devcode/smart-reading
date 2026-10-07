import type { Ctx } from "../context.ts";
import type { HighlightDto } from "../../shared/types.ts";
import { MAX_SPAN_PAGES, PAGE_JOIN } from "../../shared/types.ts";
import { CONTEXT_CHARS, findSpan, paragraphBounds } from "../text/anchor.ts";
import { getPageText } from "../library.ts";
import { badRequest, notFound } from "../errors.ts";

interface HlRow {
  id: number;
  doc_id: number;
  page: number;
  end_page: number | null;
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
  endPage: r.end_page ?? r.page,
  start: r.start,
  end: r.end,
  text: r.text,
  note: r.note,
  stale: !!r.stale,
});

// ---------- spans ----------

/** What the reader sends for a selection. A selection over several pages carries the text on its first
 *  and last page; the pages in between are taken whole from the stored text. */
export interface SelectionInput {
  docId: number;
  page: number;
  selectionText: string;
  hint?: number;
  /** last page of a selection that crosses pages */
  endPage?: number;
  /** the selected text on `endPage` */
  endText?: string;
}

export interface ResolvedSpan {
  page: number;
  endPage: number;
  start: number;
  end: number;
  /** exact text: the slice of the page, or the per-page slices joined with PAGE_JOIN */
  text: string;
}

/** The text of a span: always read from the stored pages, never from what the browser sent. */
export function spanText(ctx: Ctx, docId: number, page: number, start: number, endPage: number, end: number): string | null {
  const first = getPageText(ctx, docId, page);
  if (first === null) return null;
  if (endPage === page) return first.slice(start, end);
  const parts = [first.slice(start)];
  for (let p = page + 1; p < endPage; p++) {
    const t = getPageText(ctx, docId, p);
    if (t === null) return null;
    parts.push(t);
  }
  const last = getPageText(ctx, docId, endPage);
  if (last === null) return null;
  parts.push(last.slice(0, end));
  return parts.join(PAGE_JOIN);
}

/** Resolve a selection copied from the reader into an exact span of the stored page text(s). */
export function resolveSpan(ctx: Ctx, input: SelectionInput): ResolvedSpan {
  const { docId, page } = input;
  const first = getPageText(ctx, docId, page);
  if (first === null) throw notFound("That page does not exist in this document.");
  const fail = () =>
    badRequest("Could not match that selection to the document text. Try selecting a shorter span.");

  const sA = findSpan(first, input.selectionText, input.hint);
  if (!sA) throw fail();
  const endPage = input.endPage ?? page;
  if (endPage === page) return { page, endPage, start: sA.start, end: sA.end, text: sA.text };

  if (endPage < page) throw badRequest("The selection ends before it starts.");
  if (endPage - page + 1 > MAX_SPAN_PAGES) {
    throw badRequest(`A selection can cover at most ${MAX_SPAN_PAGES} pages.`);
  }
  if (!input.endText) throw badRequest("endText is required when endPage is set.");
  const last = getPageText(ctx, docId, endPage);
  if (last === null) throw notFound("That page does not exist in this document.");
  // The selection ends near the top of the last page, so prefer the match closest to its start.
  const sB = findSpan(last, input.endText, 0);
  if (!sB) throw fail();
  const text = spanText(ctx, docId, page, sA.start, endPage, sB.end);
  if (text === null) throw notFound("That page does not exist in this document.");
  return { page, endPage, start: sA.start, end: sB.end, text };
}

/** The paragraph(s) around a span, across pages if the span crosses them. */
export function paragraphAround(ctx: Ctx, docId: number, s: { page: number; endPage: number; start: number; end: number }) {
  const first = getPageText(ctx, docId, s.page) ?? "";
  if (s.endPage === s.page) {
    const b = paragraphBounds(first, s.start, s.end);
    return { text: first.slice(b.start, b.end), start: b.start };
  }
  const last = getPageText(ctx, docId, s.endPage) ?? "";
  const bA = paragraphBounds(first, s.start, first.length);
  const bB = paragraphBounds(last, 0, s.end);
  const text = spanText(ctx, docId, s.page, bA.start, s.endPage, bB.end) ?? "";
  return { text, start: bA.start };
}

// ---------- highlights ----------

export function insertHighlight(ctx: Ctx, docId: number, span: ResolvedSpan, note?: string | null): HighlightDto {
  const existing = ctx.db
    .prepare("SELECT * FROM highlights WHERE doc_id=? AND page=? AND COALESCE(end_page,page)=? AND start=? AND end=?")
    .get(docId, span.page, span.endPage, span.start, span.end) as HlRow | undefined;
  if (existing) {
    if (note !== undefined) {
      ctx.db.prepare("UPDATE highlights SET note=? WHERE id=?").run(note?.trim() || null, existing.id);
    }
    return toDto(ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(existing.id) as HlRow);
  }
  const first = getPageText(ctx, docId, span.page) ?? "";
  const last = getPageText(ctx, docId, span.endPage) ?? "";
  const prefix = first.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start);
  const suffix = last.slice(span.end, span.end + CONTEXT_CHARS);
  const info = ctx.db
    .prepare(
      `INSERT INTO highlights(doc_id, page, end_page, start, end, text, prefix, suffix, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(docId, span.page, span.endPage, span.start, span.end, span.text, prefix, suffix, note?.trim() || null, new Date().toISOString());
  return toDto(ctx.db.prepare("SELECT * FROM highlights WHERE id=?").get(Number(info.lastInsertRowid)) as HlRow);
}

export function createHighlight(ctx: Ctx, input: SelectionInput & { note?: string | null }): HighlightDto {
  return insertHighlight(ctx, input.docId, resolveSpan(ctx, input), input.note);
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
