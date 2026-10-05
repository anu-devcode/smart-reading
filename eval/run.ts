/**
 * Acceptance eval. Imports the fixture library into a throwaway library folder with the REAL
 * embedding model, then checks the gates below. Exit code 1 if any gate fails.
 *
 *   npm run eval
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../server/config.ts";
import { createContext, idle } from "../server/context.ts";
import { importFile } from "../server/ingest/pipeline.ts";
import { search } from "../server/search/search.ts";
import { createUnit } from "../server/knowledge/units.ts";
import { getPages, getDocument } from "../server/library.ts";
import { makeFixtures } from "./make-fixtures.ts";
import { EVAL_QUERIES, PDF_FIXTURES, TEXT_FIXTURES } from "./fixtures.ts";
import type { SearchResponse } from "../shared/types.ts";

const results: { gate: string; ok: boolean; detail: string }[] = [];
function gate(name: string, ok: boolean, detail = "") {
  results.push({ gate: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "smart-reading-eval-"));
  // reuse the model cache of the dev library so the model is only downloaded once
  const modelsDir = resolve("library-data", "models");
  const cfg = loadConfig({ libraryDir: dir, modelsDir, embeddings: "on" });
  const ctx = createContext(cfg);

  try {
    const fixtureDir = makeFixtures();
    const idByFile = new Map<string, number>();
    const fileById = new Map<number, string>();
    const files = [...PDF_FIXTURES.map((f) => f.file), ...TEXT_FIXTURES.map((t) => t.file)];

    console.log("Importing fixtures and building the meaning index (first run downloads the model)...");
    for (const f of files) {
      const res = importFile(ctx, { name: f, data: readFileSync(join(fixtureDir, f)) });
      await res.done;
      idByFile.set(f, res.document.id);
      fileById.set(res.document.id, f);
    }
    await idle(ctx);

    // ---------- gate: honest processing status ----------
    for (const f of PDF_FIXTURES) {
      const doc = getDocument(ctx, idByFile.get(f.file)!)!;
      gate(`status ${f.file} is ${f.expectStatus}`, doc.processingStatus === f.expectStatus, `got ${doc.processingStatus}${doc.failureNotes.length ? ` (${doc.failureNotes.join("; ")})` : ""}`);
      if (f.expectStatus !== "ready") gate(`status ${f.file} explains why`, doc.failureNotes.length > 0);
    }
    gate("no document is left embedding-pending", [...idByFile.values()].every((id) => !getDocument(ctx, id)!.embeddingPending));

    // ---------- gate: every passage is an exact substring of its page ----------
    {
      let bad = 0;
      let total = 0;
      const rows = ctx.db.prepare("SELECT doc_id, page, start, end, text FROM passages").all() as {
        doc_id: number; page: number; start: number; end: number; text: string;
      }[];
      const pageCache = new Map<number, Map<number, string>>();
      for (const r of rows) {
        if (!pageCache.has(r.doc_id)) pageCache.set(r.doc_id, new Map(getPages(ctx, r.doc_id).map((p) => [p.page, p.text])));
        total++;
        if (pageCache.get(r.doc_id)!.get(r.page)?.slice(r.start, r.end) !== r.text) bad++;
      }
      gate("all passages are exact substrings of their page", bad === 0, `${total} passages, ${bad} mismatches`);
    }

    // ---------- gate: the fixed query list ----------
    const run = new Map<string, SearchResponse>();
    for (const q of EVAL_QUERIES) {
      const res = await search(ctx, q.query);
      run.set(q.id, res);
      const expectId = idByFile.get(q.expectFile)!;
      let rank = -1;
      if (q.kind === "field") {
        rank = res.files.findIndex((f) => f.docId === expectId);
      } else {
        rank = res.passages.findIndex((p) => p.docId === expectId && (q.expectPage === undefined || p.page === q.expectPage));
      }
      const ok = rank >= 0 && rank < q.topK;
      gate(`${q.kind} "${q.query}" -> ${q.expectFile}${q.expectPage ? ` p.${q.expectPage}` : ""} in top ${q.topK}`, ok, `rank ${rank < 0 ? "not found" : rank + 1}`);
      if (q.kind === "meaning") {
        gate(`meaning "${q.query}" used the meaning index`, res.interpreted.semantic === "used", res.interpreted.semantic);
      }
      if (q.kind === "phrase" || q.kind === "boolean") {
        const top = res.passages[0];
        if (q.query.startsWith('"')) gate(`phrase ${q.id} is an exact match (not a fuzzy one)`, !!top?.why.exactPhrase);
      }
    }
    {
      const notRes = run.get("boolean-not");
      const bad = notRes?.passages.some((p) => /cramming/i.test(p.text));
      gate("NOT query excludes the unwanted word", bad === false);
    }

    // ---------- the success test ----------
    // "Find the passage where I read that attention is a scarce resource, without chatting, traced to a page."
    {
      const res = await search(ctx, "attention is a scarce resource");
      const top = res.passages[0];
      const expectId = idByFile.get("attention-budget.pdf")!;
      gate("success test: top hit is the right document and page", !!top && top.docId === expectId && top.page === 2, top ? `${top.docTitle} p.${top.page}` : "no hit");
      if (top) {
        const pageText = getPages(ctx, top.docId).find((p) => p.page === top.page)!.text;
        const { unit } = await createUnit(ctx, {
          type: "quote",
          docId: top.docId,
          page: top.page,
          selectionText: top.text.slice(0, 60),
        });
        gate("success test: kept quote is an exact substring of the source page", pageText.slice(unit.start, unit.end) === unit.content, `p.${unit.page} [${unit.start},${unit.end})`);
        const again = await search(ctx, "scarce resource");
        gate("success test: kept quote is findable under 'what you have saved'", again.saved.units.some((u) => u.unit.id === unit.id));
      }
    }

    // ---------- gate: meaning search needs no shared words ----------
    {
      const q = "why do big programs get harder to modify as they grow";
      const res = await search(ctx, q);
      const lexicalOnly = res.passages.find((p) => p.why.semantic === null);
      console.log(`\ninfo: for the meaning query "${q}", ${lexicalOnly ? "some" : "no"} hits came from keywords alone.`);
    }
  } finally {
    try { ctx.db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed.`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(` - ${f.gate}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
