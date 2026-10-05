import type { Ctx } from "../context.ts";
import type { ParsedQuery } from "./query.ts";

// Keyword retrieval: SQLite FTS5 with Porter stemming and BM25 ranking.
// This is the inspectable core of search. Exact phrases, boolean and field queries live here.

export interface LexPassage {
  id: number;
  doc_id: number;
  page: number;
  start: number;
  end: number;
  text: string;
  title: string;
  snip: string;
  score: number;
}

export interface LexUnit {
  id: number;
  snip: string;
  score: number;
}

const SNIP = "snippet(%T%, %C%, char(1), char(2), '…', 28)";

/** Document-level restrictions shared by passage and unit search. */
function docFilterSql(pq: ParsedQuery, alias: string): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (pq.filters.status) {
    parts.push(`d.reading_status = ?`);
    args.push(pq.filters.status);
  }
  if (pq.filters.kind) {
    parts.push(`d.kind = ?`);
    args.push(pq.filters.kind);
  }
  if (pq.docExpr) {
    parts.push(`${alias}.doc_id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)`);
    args.push(pq.docExpr);
  }
  return { sql: parts.length ? " AND " + parts.join(" AND ") : "", args };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    // an expression FTS5 rejects should yield no hits, never a 500
    return fallback;
  }
}

export function lexicalPassages(ctx: Ctx, pq: ParsedQuery, expr: string | null, limit: number): LexPassage[] {
  if (!expr) return [];
  const f = docFilterSql(pq, "p");
  const sql = `
    SELECT p.id, p.doc_id, p.page, p.start, p.end, p.text, d.title,
           ${SNIP.replace("%T%", "passages_fts").replace("%C%", "0")} AS snip,
           bm25(passages_fts) AS score
    FROM passages_fts
    JOIN passages p ON p.id = passages_fts.rowid
    JOIN documents d ON d.id = p.doc_id
    WHERE passages_fts MATCH ? ${f.sql}
    ORDER BY bm25(passages_fts)
    LIMIT ?`;
  return safe(() => ctx.db.prepare(sql).all(expr, ...f.args, limit) as LexPassage[], []);
}

export function lexicalUnits(ctx: Ctx, pq: ParsedQuery, expr: string | null, limit: number): LexUnit[] {
  let match: string | null = expr;
  if (pq.noteExpr) match = expr ? `(${expr}) AND ${pq.noteExpr}` : pq.noteExpr;
  if (!match) return [];
  const f = docFilterSql(pq, "u");
  const typeSql = pq.filters.type ? " AND u.type = ?" : "";
  const typeArgs = pq.filters.type ? [pq.filters.type] : [];
  const sql = `
    SELECT u.id,
           ${SNIP.replace("%T%", "units_fts").replace("%C%", "-1")} AS snip,
           bm25(units_fts) AS score
    FROM units_fts
    JOIN units u ON u.id = units_fts.rowid
    JOIN documents d ON d.id = u.doc_id
    WHERE units_fts MATCH ? ${f.sql}${typeSql}
    ORDER BY bm25(units_fts)
    LIMIT ?`;
  return safe(() => ctx.db.prepare(sql).all(match, ...f.args, ...typeArgs, limit) as LexUnit[], []);
}

export interface LexDoc {
  id: number;
  title: string;
  author: string | null;
  kind: "pdf" | "text" | "markdown";
}

/** Documents whose title/author match (for the Files group and field-only queries like title:foo). */
export function lexicalDocs(ctx: Ctx, pq: ParsedQuery, limit: number): LexDoc[] {
  let match: string | null = null;
  if (pq.docExpr) match = pq.bodyExpr ? `(${pq.docExpr})` : pq.docExpr;
  else if (pq.bodyExpr && !pq.noteExpr) match = pq.orExpr ?? pq.bodyExpr;
  if (!match) return [];
  const parts: string[] = [];
  const args: unknown[] = [];
  if (pq.filters.status) {
    parts.push("d.reading_status = ?");
    args.push(pq.filters.status);
  }
  if (pq.filters.kind) {
    parts.push("d.kind = ?");
    args.push(pq.filters.kind);
  }
  const sql = `
    SELECT d.id, d.title, d.author, d.kind
    FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ? ${parts.length ? " AND " + parts.join(" AND ") : ""}
    ORDER BY bm25(documents_fts)
    LIMIT ?`;
  return safe(() => ctx.db.prepare(sql).all(match, ...args, limit) as LexDoc[], []);
}

/** Doc ids allowed by document-level filters, or null when there are none. */
export function allowedDocIds(ctx: Ctx, pq: ParsedQuery): Set<number> | null {
  if (!pq.filters.status && !pq.filters.kind && !pq.docExpr) return null;
  const parts: string[] = [];
  const args: unknown[] = [];
  if (pq.filters.status) {
    parts.push("d.reading_status = ?");
    args.push(pq.filters.status);
  }
  if (pq.filters.kind) {
    parts.push("d.kind = ?");
    args.push(pq.filters.kind);
  }
  if (pq.docExpr) {
    parts.push("d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)");
    args.push(pq.docExpr);
  }
  const rows = safe(
    () =>
      ctx.db.prepare(`SELECT d.id FROM documents d WHERE ${parts.join(" AND ")}`).all(...args) as { id: number }[],
    [],
  );
  return new Set(rows.map((r) => r.id));
}
