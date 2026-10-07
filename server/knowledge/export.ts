import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../context.ts";
import { pagesLabel } from "../../shared/types.ts";

// A portable snapshot of everything the USER owns: sources list, highlights, accepted knowledge,
// relations, and provenance. Embeddings are deliberately excluded (derived, rebuildable).

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  documents: {
    hash: string;
    title: string;
    author: string | null;
    year: number | null;
    kind: string;
    originalName: string;
    pageCount: number;
    readingStatus: string;
    processingStatus: string;
    addedAt: string;
  }[];
  highlights: {
    documentHash: string;
    page: number;
    endPage: number;
    start: number;
    end: number;
    text: string;
    note: string | null;
  }[];
  units: {
    id: number;
    type: string;
    content: string;
    note: string | null;
    origin: string;
    edited: boolean;
    acceptedAt: string;
    source: {
      documentHash: string;
      documentTitle: string;
      page: number;
      endPage: number;
      start: number;
      end: number;
      text: string;
    };
  }[];
  links: { fromUnit: number; toUnit: number; relation: string }[];
  collections: { name: string; query: string }[];
}

export function buildExport(ctx: Ctx): ExportBundle {
  const docs = ctx.db.prepare("SELECT * FROM documents ORDER BY id").all() as any[];
  const hashOf = new Map<number, string>(docs.map((d) => [d.id, d.content_hash]));
  const titleOf = new Map<number, string>(docs.map((d) => [d.id, d.title]));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    documents: docs.map((d) => ({
      hash: d.content_hash,
      title: d.title,
      author: d.author,
      year: d.year,
      kind: d.kind,
      originalName: d.original_name,
      pageCount: d.page_count,
      readingStatus: d.reading_status,
      processingStatus: d.processing_status,
      addedAt: d.added_at,
    })),
    highlights: (ctx.db.prepare("SELECT * FROM highlights ORDER BY doc_id, page, start").all() as any[]).map((h) => ({
      documentHash: hashOf.get(h.doc_id)!,
      page: h.page,
      endPage: h.end_page ?? h.page,
      start: h.start,
      end: h.end,
      text: h.text,
      note: h.note,
    })),
    units: (ctx.db.prepare("SELECT * FROM units ORDER BY id").all() as any[]).map((u) => ({
      id: u.id,
      type: u.type,
      content: u.content,
      note: u.note,
      origin: u.origin,
      edited: !!u.edited,
      acceptedAt: u.accepted_at,
      source: {
        documentHash: hashOf.get(u.doc_id)!,
        documentTitle: titleOf.get(u.doc_id)!,
        page: u.page,
        endPage: u.end_page ?? u.page,
        start: u.start,
        end: u.end,
        text: u.source_text,
      },
    })),
    links: (ctx.db.prepare("SELECT from_id, to_id, relation FROM unit_links ORDER BY id").all() as any[]).map((l) => ({
      fromUnit: l.from_id,
      toUnit: l.to_id,
      relation: l.relation,
    })),
    collections: ctx.db.prepare("SELECT name, query FROM collections ORDER BY id").all() as { name: string; query: string }[],
  };
}

const LABEL: Record<string, string> = { quote: "Quote", idea: "Idea", concept: "Concept", question: "Question" };

export function buildMarkdown(ctx: Ctx): string {
  const b = buildExport(ctx);
  const byDoc = new Map<string, ExportBundle["units"]>();
  for (const u of b.units) {
    const list = byDoc.get(u.source.documentHash) ?? [];
    list.push(u);
    byDoc.set(u.source.documentHash, list);
  }
  const lines: string[] = ["# Knowledge export", "", `Exported ${b.exportedAt}`, ""];
  for (const d of b.documents) {
    const units = byDoc.get(d.hash);
    if (!units?.length) continue;
    const meta = [d.author, d.year].filter(Boolean).join(", ");
    lines.push(`## ${d.title}${meta ? ` (${meta})` : ""}`, "");
    for (const u of units) {
      lines.push(`- **${LABEL[u.type] ?? u.type}**: ${u.content.replace(/\n+/g, " ")}`);
      if (u.type !== "quote") lines.push(`  > ${u.source.text.replace(/\n+/g, " ")}`);
      if (u.note) lines.push(`  - Note: ${u.note.replace(/\n+/g, " ")}`);
      lines.push(`  - Source: ${d.title}, ${pagesLabel(u.source.page, u.source.endPage)}`);
    }
    lines.push("");
  }
  const rel = b.links.map((l) => {
    const a = b.units.find((u) => u.id === l.fromUnit);
    const c = b.units.find((u) => u.id === l.toUnit);
    return a && c ? `- "${a.content.slice(0, 60)}" ${l.relation.replace("_", " ")} "${c.content.slice(0, 60)}"` : null;
  });
  const relLines = rel.filter((x): x is string => !!x);
  if (relLines.length) lines.push("## Connections", "", ...relLines, "");
  return lines.join("\n");
}

export function exportToDir(ctx: Ctx): { dir: string; files: string[] } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ctx.cfg.libraryDir, "exports", stamp);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "library.json");
  const md = join(dir, "knowledge.md");
  writeFileSync(json, JSON.stringify(buildExport(ctx), null, 2), "utf8");
  writeFileSync(md, buildMarkdown(ctx), "utf8");
  return { dir, files: [json, md] };
}
