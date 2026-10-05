import type { Ctx } from "../context.ts";
import type {
  FileHit,
  PassageHit,
  SearchResponse,
  UnitHit,
  UnitType,
  Why,
} from "../../shared/types.ts";
import { UNIT_TYPES } from "../../shared/types.ts";
import { markedTerms, parseQuery, type ParsedQuery } from "./query.ts";
import {
  allowedDocIds,
  lexicalDocs,
  lexicalPassages,
  lexicalUnits,
  type LexPassage,
  type LexUnit,
} from "./lexical.ts";
import { getUnit, listUnits } from "../knowledge/units.ts";

const RRF_K = 60;
const PASSAGE_LIMIT = 20;
const UNIT_LIMIT = 12;
const FETCH = 40;

const rrf = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (RRF_K + rank + 1));

interface SemanticResult {
  state: SearchResponse["interpreted"]["semantic"];
  passages: Map<number, number>; // passage id -> cosine
  units: Map<number, number>; // unit id -> cosine
}

async function semanticSearch(ctx: Ctx, pq: ParsedQuery, skipPassages: boolean): Promise<SemanticResult> {
  const none = (state: SemanticResult["state"]): SemanticResult => ({ state, passages: new Map(), units: new Map() });
  if (!ctx.embedder) return none("skipped");
  if (!pq.semanticText) return none("skipped");
  // A NOT query means "exclude this topic"; fuzzy meaning matches would contradict it.
  if (/\bNOT\b/.test(pq.raw)) return none("skipped");
  if (ctx.vectors.passage.size() + ctx.vectors.unit.size() === 0) {
    return none(ctx.embedJob.state === "unavailable" ? "unavailable" : "skipped");
  }

  let qv: Float32Array;
  try {
    [qv] = await ctx.embedder.embed([pq.semanticText], "query");
  } catch {
    return none("unavailable");
  }

  const allowed = allowedDocIds(ctx, pq);
  const min = ctx.cfg.semanticMin;
  const out = none("used");

  if (!skipPassages) {
    const hits = ctx.vectors.passage.search(qv, FETCH).filter((h) => h.score >= min);
    const docOf = ctx.db.prepare("SELECT doc_id d FROM passages WHERE id = ?");
    for (const h of hits) {
      if (allowed) {
        const r = docOf.get(h.id) as { d: number } | undefined;
        if (!r || !allowed.has(r.d)) continue;
      }
      out.passages.set(h.id, h.score);
    }
  }
  const uHits = ctx.vectors.unit.search(qv, FETCH).filter((h) => h.score >= min);
  const unitInfo = ctx.db.prepare("SELECT doc_id d, type t FROM units WHERE id = ?");
  for (const h of uHits) {
    const r = unitInfo.get(h.id) as { d: number; t: UnitType } | undefined;
    if (!r) continue;
    if (allowed && !allowed.has(r.d)) continue;
    if (pq.filters.type && r.t !== pq.filters.type) continue;
    out.units.set(h.id, h.score);
  }
  return out;
}

function hydratePassages(ctx: Ctx, ids: number[]): Map<number, LexPassage> {
  const m = new Map<number, LexPassage>();
  if (!ids.length) return m;
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.doc_id, p.page, p.start, p.end, p.text, d.title, '' AS snip, 0 AS score
       FROM passages p JOIN documents d ON d.id = p.doc_id WHERE p.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as LexPassage[];
  rows.forEach((r) => m.set(r.id, r));
  return m;
}

function plainSnippet(text: string): string {
  return text.length > 240 ? text.slice(0, 240).trimEnd() + "…" : text;
}

export async function search(ctx: Ctx, raw: string): Promise<SearchResponse> {
  const pq = parseQuery(raw);
  const skipPassages = !!pq.filters.type || !!pq.noteExpr;

  // ---------- keyword retrieval ----------
  let mode: SearchResponse["interpreted"]["mode"] = "none";
  let lp: LexPassage[] = [];
  let lu: LexUnit[] = [];
  let browseUnits = false;

  if (pq.bodyExpr) {
    mode = "and";
    lp = skipPassages ? [] : lexicalPassages(ctx, pq, pq.bodyExpr, FETCH);
    lu = lexicalUnits(ctx, pq, pq.bodyExpr, FETCH);
    if (!pq.structured && pq.orExpr && lp.length + lu.length < 3) {
      mode = "or";
      lp = skipPassages ? [] : lexicalPassages(ctx, pq, pq.orExpr, FETCH);
      lu = lexicalUnits(ctx, pq, pq.orExpr, FETCH);
    }
  } else if (pq.noteExpr) {
    mode = "and";
    lu = lexicalUnits(ctx, pq, null, FETCH);
  } else if (pq.filters.type && !pq.docExpr) {
    browseUnits = true; // "type:idea" on its own lists them
  }

  // ---------- meaning retrieval ----------
  const sem = await semanticSearch(ctx, pq, skipPassages);

  // ---------- merge: passages ----------
  const lexRank = new Map<number, number>();
  lp.forEach((r, i) => lexRank.set(r.id, i));
  const semOrder = [...sem.passages.entries()].sort((a, b) => b[1] - a[1]);
  const semRank = new Map<number, number>();
  semOrder.forEach(([id], i) => semRank.set(id, i));

  const allIds = new Set<number>([...lexRank.keys(), ...semRank.keys()]);
  let orderedIds: number[];
  if (pq.structured && lexRank.size > 0) {
    // exact phrase / boolean / field queries: exact matches always first, meaning matches fill in below
    const lexIds = lp.map((r) => r.id);
    const semOnly = semOrder.map(([id]) => id).filter((id) => !lexRank.has(id));
    orderedIds = [...lexIds, ...semOnly];
  } else {
    orderedIds = [...allIds].sort(
      (a, b) => rrf(lexRank.get(b)) + rrf(semRank.get(b)) - (rrf(lexRank.get(a)) + rrf(semRank.get(a))),
    );
  }
  const lexById = new Map(lp.map((r) => [r.id, r]));
  const missing = orderedIds.filter((id) => !lexById.has(id));
  const hydrated = hydratePassages(ctx, missing);

  const toPassageHit = (id: number): PassageHit | null => {
    const r = lexById.get(id) ?? hydrated.get(id);
    if (!r) return null;
    const lexical = lexRank.has(id);
    const why: Why = {
      lexical,
      semantic: sem.passages.get(id) ?? null,
      exactPhrase: lexical && pq.phrases.length > 0,
      terms: lexical ? markedTerms(r.snip) : [],
    };
    return {
      passageId: r.id,
      docId: r.doc_id,
      docTitle: r.title,
      page: r.page,
      start: r.start,
      end: r.end,
      text: r.text,
      snippet: lexical ? r.snip : plainSnippet(r.text),
      why,
      score: rrf(lexRank.get(id)) + rrf(semRank.get(id)),
    };
  };
  const allPassages = orderedIds.map(toPassageHit).filter((x): x is PassageHit => !!x);
  const passages = allPassages.slice(0, PASSAGE_LIMIT);

  // ---------- merge: units ----------
  const uLexRank = new Map<number, number>();
  lu.forEach((r, i) => uLexRank.set(r.id, i));
  const uSemOrder = [...sem.units.entries()].sort((a, b) => b[1] - a[1]);
  const uSemRank = new Map<number, number>();
  uSemOrder.forEach(([id], i) => uSemRank.set(id, i));
  const uAll = new Set<number>([...uLexRank.keys(), ...uSemRank.keys()]);
  let uOrdered: number[];
  if (browseUnits) {
    uOrdered = listUnits(ctx, { type: pq.filters.type }).map((u) => u.id);
  } else if (pq.structured && uLexRank.size > 0) {
    uOrdered = [...lu.map((r) => r.id), ...uSemOrder.map(([id]) => id).filter((id) => !uLexRank.has(id))];
  } else {
    uOrdered = [...uAll].sort(
      (a, b) => rrf(uLexRank.get(b)) + rrf(uSemRank.get(b)) - (rrf(uLexRank.get(a)) + rrf(uSemRank.get(a))),
    );
  }
  const luById = new Map(lu.map((r) => [r.id, r]));
  const allUnits: UnitHit[] = [];
  for (const id of uOrdered) {
    const unit = getUnit(ctx, id);
    if (!unit) continue;
    const row = luById.get(id);
    const lexical = uLexRank.has(id);
    allUnits.push({
      unit,
      snippet: row?.snip || unit.content,
      why: {
        lexical,
        semantic: sem.units.get(id) ?? null,
        exactPhrase: lexical && pq.phrases.length > 0,
        terms: row ? markedTerms(row.snip) : [],
      },
      score: rrf(uLexRank.get(id)) + rrf(uSemRank.get(id)),
    });
  }
  const counts = Object.fromEntries(UNIT_TYPES.map((t) => [t, 0])) as Record<UnitType, number>;
  for (const h of allUnits) counts[h.unit.type]++;

  // ---------- files ----------
  const byDoc = new Map<number, FileHit>();
  const ensureDoc = (docId: number): FileHit | null => {
    let f = byDoc.get(docId);
    if (!f) {
      const d = ctx.db.prepare("SELECT id, title, author, kind FROM documents WHERE id = ?").get(docId) as
        | { id: number; title: string; author: string | null; kind: FileHit["kind"] }
        | undefined;
      if (!d) return null;
      f = { docId: d.id, title: d.title, author: d.author, kind: d.kind, passageHits: 0, unitCount: 0, titleMatch: false };
      byDoc.set(docId, f);
    }
    return f;
  };
  for (const p of allPassages) {
    const f = ensureDoc(p.docId);
    if (f) f.passageHits++;
  }
  for (const u of allUnits) {
    const f = ensureDoc(u.unit.docId);
    if (f) f.unitCount++;
  }
  for (const d of lexicalDocs(ctx, pq, 20)) {
    const f = ensureDoc(d.id);
    if (f) f.titleMatch = true;
  }
  const files = [...byDoc.values()]
    .sort(
      (a, b) =>
        Number(b.titleMatch) - Number(a.titleMatch) || b.passageHits + b.unitCount - (a.passageHits + a.unitCount),
    )
    .slice(0, 12);

  return {
    query: raw,
    interpreted: { structured: pq.structured, filters: pq.filters, semantic: sem.state, mode },
    saved: { counts, units: allUnits.slice(0, UNIT_LIMIT) },
    passages,
    files,
  };
}
