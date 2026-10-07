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
import { EVAL_QUERIES, PDF_FIXTURES, SCANNED_TEXT, TEXT_FIXTURES } from "./fixtures.ts";
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
      const expected = f.expectStatusWithOcr ?? f.expectStatus; // this run has OCR switched on
      gate(`status ${f.file} is ${expected}`, doc.processingStatus === expected, `got ${doc.processingStatus}${doc.failureNotes.length ? ` (${doc.failureNotes.join("; ")})` : ""}`);
      if (expected !== "ready") gate(`status ${f.file} explains why`, doc.failureNotes.length > 0);
    }
    gate("no document is left embedding-pending", [...idByFile.values()].every((id) => !getDocument(ctx, id)!.embeddingPending));
    gate("no document is left waiting for OCR", [...idByFile.values()].every((id) => getDocument(ctx, id)!.ocrPending === 0));

    // ---------- gates: OCR (the real engine) ----------
    {
      const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];
      for (const [file, pagesText] of Object.entries(SCANNED_TEXT)) {
        const id = idByFile.get(file)!;
        const pages = getPages(ctx, id);
        pagesText.forEach((paras, i) => {
          if (!paras.length) {
            gate(`ocr ${file} p.${i + 1}: a typed page is not sent to OCR`, pages[i].ocr === false);
            return;
          }
          const got = new Set(words(pages[i].text));
          const want = words(paras.join(" "));
          const hit = want.filter((w) => got.has(w)).length;
          gate(`ocr ${file} p.${i + 1}: read as OCR text`, pages[i].status === "ok" && pages[i].ocr === true);
          gate(`ocr ${file} p.${i + 1}: at least 95% of the words are read correctly`, hit / want.length >= 0.95, `${hit}/${want.length} words`);
        });
        const notes = getDocument(ctx, id)!.failureNotes.join(" ");
        gate(`ocr ${file}: the document says its text was read with OCR`, /read from the page image with OCR/.test(notes));
      }
      for (const file of ["fully-scanned.pdf", "partly-scanned.pdf"]) {
        const id = idByFile.get(file)!;
        const empties = getPages(ctx, id).filter((p) => p.status === "empty");
        const reasons = ctx.db.prepare("SELECT reason FROM ocr_pages WHERE doc_id = ? AND status = 'rejected'").all(id) as { reason: string }[];
        gate(`ocr ${file}: pages with nothing to read are not guessed at`, empties.length > 0 && empties.every((p) => p.text === "" && !p.ocr) && reasons.length === empties.length);
        gate(`ocr ${file}: says why OCR gave up`, /OCR could not read/.test(getDocument(ctx, id)!.failureNotes.join(" ")));
      }
      const real = getPages(ctx, idByFile.get("attention-budget.pdf")!);
      gate("ocr: documents with real text are not read as images", real.every((p) => !p.ocr));
      // a quote on an OCR page is an exact slice of that page
      const memo = idByFile.get("scanned-memo.pdf")!;
      const { unit } = await createUnit(ctx, { type: "quote", docId: memo, page: 2, selectionText: "harbour pilots relied on those tables" });
      const memoText = getPages(ctx, memo)[1].text;
      gate("ocr: a kept quote is an exact substring of the OCR page", memoText.slice(unit.start, unit.end) === unit.content, JSON.stringify(unit.content));
    }

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
    await ctx.ocrJob.close().catch(() => undefined);
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
