import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { search } from "../server/search/search.ts";
import { PDF_FIXTURES } from "../eval/fixtures.ts";
import type { Ctx } from "../server/context.ts";
import { FakeEmbedder, importFixture, tempCtx } from "./helpers.ts";

let cleanup: () => void;
let ctx: Ctx;
const docs = new Map<string, number>();

async function load(files: string[]) {
  for (const f of files) docs.set(f, await importFixture(ctx, f));
}

describe("keyword search (lexical only)", () => {
  beforeEach(async () => {
    const t = tempCtx();
    ctx = t.ctx;
    cleanup = t.cleanup;
    docs.clear();
    await load([...PDF_FIXTURES.map((f) => f.file), "reading-notes.md"]);
  });
  afterEach(() => cleanup());

  it("exact phrase returns exactly the right passage first, with page and snippet", async () => {
    const r = await search(ctx, '"best alternative you gave up"');
    expect(r.passages.length).toBeGreaterThan(0);
    const top = r.passages[0];
    expect(top.docId).toBe(docs.get("choices-and-trade-offs.pdf"));
    expect(top.page).toBe(1);
    expect(top.why.lexical).toBe(true);
    expect(top.why.exactPhrase).toBe(true);
    expect(top.snippet).toContain("\u0001");
    expect(r.interpreted.structured).toBe(true);
  });

  it("matches stems (interruption finds interruptions)", async () => {
    const r = await search(ctx, "interruption");
    expect(r.passages.some((p) => p.docId === docs.get("attention-budget.pdf"))).toBe(true);
  });

  it("supports AND, and NOT excludes", async () => {
    const both = await search(ctx, "forgetting AND intervals");
    expect(both.passages[0].docId).toBe(docs.get("learning-that-lasts.pdf"));
    expect(both.passages[0].page).toBe(2);

    const not = await search(ctx, "memory NOT cramming");
    expect(not.passages.length).toBeGreaterThan(0);
    for (const p of not.passages) expect(p.text.toLowerCase()).not.toContain("cramming");
  });

  it("title: scopes to documents and returns files", async () => {
    const r = await search(ctx, "title:complexity");
    expect(r.files.map((f) => f.docId)).toContain(docs.get("systems-and-complexity.pdf"));
    expect(r.files[0].titleMatch).toBe(true);
    expect(r.passages.length).toBe(0);
  });

  it("status: filter restricts by reading status", async () => {
    const id = docs.get("attention-budget.pdf")!;
    ctx.db.prepare("UPDATE documents SET reading_status='reading' WHERE id=?").run(id);
    const only = await search(ctx, "attention status:reading");
    expect(only.passages.length).toBeGreaterThan(0);
    expect(only.passages.every((p) => p.docId === id)).toBe(true);
    const none = await search(ctx, "attention status:finished");
    expect(none.passages.length).toBe(0);
  });

  it("falls back to OR for natural-language queries that AND would miss", async () => {
    const r = await search(ctx, "why do big programs get harder to modify as they grow");
    expect(r.interpreted.mode).toBe("or");
    expect(r.passages.some((p) => p.docId === docs.get("systems-and-complexity.pdf"))).toBe(true);
  });

  it("never throws on hostile input", async () => {
    for (const q of ['"', "(((", "AND OR NOT", "title:", "a:b:c", "***", "'; DROP TABLE documents;--", "\u0001\u0002"]) {
      await expect(search(ctx, q)).resolves.toBeDefined();
    }
    const n = ctx.db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number };
    expect(n.c).toBeGreaterThan(0);
  });

  it("does not index passages of a failed (scanned) document", async () => {
    const r = await search(ctx, "quarterly");
    expect(r.passages.every((p) => p.docId !== docs.get("fully-scanned.pdf"))).toBe(true);
    expect(r.passages.some((p) => p.docId === docs.get("partly-scanned.pdf"))).toBe(true);
  });

  it("empty query returns an empty response", async () => {
    const r = await search(ctx, "");
    expect(r.passages).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it("finds markdown content too", async () => {
    const r = await search(ctx, "friction");
    expect(r.passages.some((p) => p.docId === docs.get("reading-notes.md"))).toBe(true);
  });
});

describe("hybrid search plumbing (fake embedder)", () => {
  let fake: FakeEmbedder;
  beforeEach(async () => {
    fake = new FakeEmbedder();
    const t = tempCtx({ embedder: fake });
    ctx = t.ctx;
    cleanup = t.cleanup;
    docs.clear();
    await load(["attention-budget.pdf", "learning-that-lasts.pdf", "systems-and-complexity.pdf"]);
  });
  afterEach(() => cleanup());

  it("embeds every passage in the background and reports no pending work", async () => {
    expect(ctx.embedJob.pendingCount()).toBe(0);
    const n = ctx.db.prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='passage'").get() as { c: number };
    const p = ctx.db.prepare("SELECT COUNT(*) c FROM passages").get() as { c: number };
    expect(n.c).toBe(p.c);
  });

  it("reports semantic contribution and keeps exact phrase matches first", async () => {
    const r = await search(ctx, '"attention is a scarce resource"');
    expect(r.passages[0].why.exactPhrase).toBe(true);
    expect(r.passages[0].page).toBe(2);
    expect(r.interpreted.semantic).toBe("used");
  });

  it("does not use meaning search for NOT queries", async () => {
    const r = await search(ctx, "memory NOT cramming");
    expect(r.interpreted.semantic).toBe("skipped");
  });

  it("degrades gracefully when the embedder fails", async () => {
    const broken = { name: "broken", embed: async () => Promise.reject(new Error("offline")) };
    (ctx as { embedder: unknown }).embedder = broken;
    const r = await search(ctx, "attention scarce");
    expect(r.interpreted.semantic).toBe("unavailable");
    expect(r.passages.length).toBeGreaterThan(0); // keyword search still works
  });
});
