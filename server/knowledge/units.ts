import type { Ctx } from "../context.ts";
import type {
  CreateUnitResponse,
  Relation,
  UnitContextDto,
  UnitDto,
  UnitType,
} from "../../shared/types.ts";
import { RELATIONS, UNIT_TYPES } from "../../shared/types.ts";
import { forIndex } from "../text/dehyphen.ts";

import { badRequest, notFound } from "../errors.ts";
import { insertHighlight, paragraphAround, resolveSpan, type SelectionInput } from "./highlights.ts";
import { toBlob } from "../search/embeddings.ts";

export interface UnitRow {
  id: number;
  type: UnitType;
  content: string;
  doc_id: number;
  doc_title: string;
  doc_author: string | null;
  doc_year: number | null;
  page: number;
  end_page: number | null;
  start: number;
  end: number;
  source_text: string;
  passage_id: number | null;
  highlight_id: number | null;
  note: string | null;
  origin: "manual" | "distill";
  edited: number;
  accepted_at: string;
}

export const UNIT_SELECT = `SELECT u.*, d.title AS doc_title, d.author AS doc_author, d.year AS doc_year FROM units u JOIN documents d ON d.id = u.doc_id`;

export function rowToUnit(r: UnitRow): UnitDto {
  return {
    id: r.id,
    type: r.type,
    content: r.content,
    docId: r.doc_id,
    docTitle: r.doc_title,
    docAuthor: r.doc_author,
    docYear: r.doc_year,
    page: r.page,
    endPage: r.end_page ?? r.page,
    start: r.start,
    end: r.end,
    sourceText: r.source_text,
    passageId: r.passage_id,
    highlightId: r.highlight_id,
    note: r.note,
    origin: r.origin,
    edited: !!r.edited,
    acceptedAt: r.accepted_at,
  };
}

export function getUnit(ctx: Ctx, id: number): UnitDto | null {
  const r = ctx.db.prepare(`${UNIT_SELECT} WHERE u.id = ?`).get(id) as UnitRow | undefined;
  return r ? rowToUnit(r) : null;
}

export const SAME_IDEA_MIN = 0.6;

function setUnitFts(ctx: Ctx, id: number, content: string, note: string | null) {
  ctx.db.prepare("DELETE FROM units_fts WHERE rowid = ?").run(id);
  ctx.db.prepare("INSERT INTO units_fts(rowid, content, note) VALUES (?,?,?)").run(id, forIndex(content), note ?? "");
}

/** Embed a unit immediately (cheap) so it is searchable by meaning and can produce a "same idea" suggestion. */
async function embedUnit(ctx: Ctx, id: number, content: string): Promise<Float32Array | null> {
  if (!ctx.embedder) return null;
  try {
    const [v] = await ctx.embedder.embed([forIndex(content)], "passage");
    ctx.db
      .prepare("INSERT OR REPLACE INTO embeddings(kind, ref_id, model, dim, vec) VALUES ('unit',?,?,?,?)")
      .run(id, ctx.cfg.embeddingModel, v.length, toBlob(v));
    ctx.vectors.unit.add(id, v);
    return v;
  } catch {
    // The background job will retry later; the unit is still keyword-searchable.
    void ctx.embedJob.kick();
    return null;
  }
}

export interface CreateUnitInput extends SelectionInput {
  type: UnitType;
  /** required for idea / concept / question. Ignored for quotes (a quote is always the exact source text). */
  content?: string;
  note?: string | null;
  origin?: "manual" | "distill";
  /** set when the unit came from a Distill candidate */
  candidateAction?: "accept" | "edit";
}

export async function createUnit(ctx: Ctx, input: CreateUnitInput): Promise<CreateUnitResponse> {
  if (!UNIT_TYPES.includes(input.type)) throw badRequest("Unknown unit type");
  const span = resolveSpan(ctx, input);

  let content: string;
  if (input.type === "quote") {
    content = span.text; // exact substring of the source, by construction
  } else {
    content = (input.content ?? "").trim();
    if (!content) throw badRequest("Write the idea, concept or question in your own words.");
  }

  const passage = ctx.db
    .prepare("SELECT id FROM passages WHERE doc_id=? AND page=? AND start<=? AND end>? ORDER BY start LIMIT 1")
    .get(input.docId, input.page, span.start, span.start) as { id: number } | undefined;

  let highlightId: number | null = null;
  if (input.type === "quote") {
    highlightId = insertHighlight(ctx, input.docId, span).id;
  }

  const info = ctx.db
    .prepare(
      `INSERT INTO units(type, content, doc_id, page, end_page, start, end, source_text, passage_id, highlight_id, note, origin, edited, accepted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.type,
      content,
      input.docId,
      input.page,
      span.endPage,
      span.start,
      span.end,
      span.text,
      passage?.id ?? null,
      highlightId,
      input.note?.trim() || null,
      input.origin ?? "manual",
      input.candidateAction === "edit" ? 1 : 0,
      new Date().toISOString(),
    );
  const id = Number(info.lastInsertRowid);
  setUnitFts(ctx, id, content, input.note?.trim() || null);

  if (input.candidateAction) recordCandidateEvent(ctx, input.candidateAction, input.type, input.docId);

  const vec = await embedUnit(ctx, id, content);
  const unit = getUnit(ctx, id)!;

  // "Same idea?" is offered once, at save time, and only for the user's own kinds of knowledge.
  let suggestion: CreateUnitResponse["suggestion"] = null;
  if (vec && input.type !== "quote") {
    const near = ctx.vectors.unit.nearest(vec, 5, id);
    for (const hit of near) {
      if (hit.score < SAME_IDEA_MIN) break;
      const other = getUnit(ctx, hit.id);
      if (other && other.type !== "quote") {
        suggestion = { unit: other, similarity: hit.score };
        break;
      }
    }
  }
  return { unit, suggestion };
}

export async function updateUnit(
  ctx: Ctx,
  id: number,
  patch: { content?: string; note?: string | null },
): Promise<UnitDto> {
  const cur = getUnit(ctx, id);
  if (!cur) throw notFound("Unit not found");
  let content = cur.content;
  let contentChanged = false;
  if (patch.content !== undefined) {
    if (cur.type === "quote") throw badRequest("A quote is the author's exact wording and cannot be edited. Add a note instead.");
    const c = patch.content.trim();
    if (!c) throw badRequest("Content cannot be empty.");
    contentChanged = c !== cur.content;
    content = c;
  }
  const note = patch.note !== undefined ? patch.note?.trim() || null : cur.note;
  ctx.db.prepare("UPDATE units SET content=?, note=?, edited = edited OR ? WHERE id=?").run(content, note, contentChanged ? 1 : 0, id);
  setUnitFts(ctx, id, content, note);
  if (contentChanged) {
    ctx.db.prepare("DELETE FROM embeddings WHERE kind='unit' AND ref_id=?").run(id);
    ctx.vectors.unit.invalidate();
    await embedUnit(ctx, id, content);
  }
  return getUnit(ctx, id)!;
}

export function deleteUnit(ctx: Ctx, id: number): void {
  ctx.db.prepare("DELETE FROM units_fts WHERE rowid = ?").run(id);
  ctx.db.prepare("DELETE FROM embeddings WHERE kind='unit' AND ref_id=?").run(id);
  ctx.db.prepare("DELETE FROM units WHERE id = ?").run(id); // links cascade
  ctx.vectors.unit.invalidate();
}

export function listUnits(ctx: Ctx, f: { type?: UnitType; docId?: number } = {}): UnitDto[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.type) {
    where.push("u.type = ?");
    args.push(f.type);
  }
  if (f.docId) {
    where.push("u.doc_id = ?");
    args.push(f.docId);
  }
  const sql = `${UNIT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY u.accepted_at DESC, u.id DESC`;
  return (ctx.db.prepare(sql).all(...args) as UnitRow[]).map(rowToUnit);
}

export function getUnitContext(ctx: Ctx, id: number): UnitContextDto {
  const unit = getUnit(ctx, id);
  if (!unit) throw notFound("Unit not found");
  const para = paragraphAround(ctx, unit.docId, unit);
  const out = ctx.db
    .prepare(`SELECT id, relation, to_id other FROM unit_links WHERE from_id = ?`)
    .all(id) as { id: number; relation: Relation; other: number }[];
  const inn = ctx.db
    .prepare(`SELECT id, relation, from_id other FROM unit_links WHERE to_id = ?`)
    .all(id) as { id: number; relation: Relation; other: number }[];
  const links: UnitContextDto["links"] = [];
  for (const l of out) {
    const other = getUnit(ctx, l.other);
    if (other) links.push({ id: l.id, relation: l.relation, direction: "out", other });
  }
  for (const l of inn) {
    const other = getUnit(ctx, l.other);
    if (other) links.push({ id: l.id, relation: l.relation, direction: "in", other });
  }
  return { unit, paragraph: para.text, paragraphStart: para.start, links };
}

// ---- relations: created only by the user ----

export function createLink(ctx: Ctx, fromId: number, toId: number, relation: Relation): number {
  if (!RELATIONS.includes(relation)) throw badRequest("Unknown relation");
  if (fromId === toId) throw badRequest("A unit cannot be linked to itself.");
  if (!getUnit(ctx, fromId) || !getUnit(ctx, toId)) throw notFound("Unit not found");
  // same_idea is symmetric: normalise direction so A~B and B~A are one link
  let [a, b] = [fromId, toId];
  if (relation === "same_idea" && a > b) [a, b] = [b, a];
  const existing = ctx.db
    .prepare("SELECT id FROM unit_links WHERE from_id=? AND to_id=? AND relation=?")
    .get(a, b, relation) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = ctx.db
    .prepare("INSERT INTO unit_links(from_id, to_id, relation, created_at) VALUES (?,?,?,?)")
    .run(a, b, relation, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function deleteLink(ctx: Ctx, id: number): void {
  ctx.db.prepare("DELETE FROM unit_links WHERE id = ?").run(id);
}

// ---- candidate events: recorded quietly, not shown, not acted on in V1 ----

export function recordCandidateEvent(
  ctx: Ctx,
  action: "accept" | "edit" | "dismiss",
  unitType: string,
  docId: number | null,
): void {
  ctx.db
    .prepare("INSERT INTO candidate_events(ts, action, unit_type, doc_id) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), action, unitType, docId);
}
