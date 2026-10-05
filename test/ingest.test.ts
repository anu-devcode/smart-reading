import { afterEach, describe, expect, it } from "vitest";
import { importFile, kindFromName, UnsupportedFileError } from "../server/ingest/pipeline.ts";
import { getDocument, getPages, listDocuments, deleteDocument, patchDocument } from "../server/library.ts";
import { PDF_FIXTURES } from "../eval/fixtures.ts";
import { idle } from "../server/context.ts";
import { importFixture, tempCtx } from "./helpers.ts";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});
const setup = () => {
  const t = tempCtx();
  cleanups.push(t.cleanup);
  return t.ctx;
};

describe("ingest", () => {
  it("assigns Ready / Partial / Failed honestly for each PDF fixture", async () => {
    const ctx = setup();
    for (const f of PDF_FIXTURES) {
      const id = await importFixture(ctx, f.file);
      const doc = getDocument(ctx, id)!;
      expect(doc.processingStatus, f.file).toBe(f.expectStatus);
    }
  });

  it("reports page ranges for a partly scanned document", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "partly-scanned.pdf");
    const doc = getDocument(ctx, id)!;
    expect(doc.pageCount).toBe(3);
    expect(doc.failureNotes.join(" ")).toMatch(/page 2/);
    const pages = getPages(ctx, id);
    expect(pages.map((p) => p.status)).toEqual(["ok", "empty", "ok"]);
  });

  it("explains a fully scanned document and indexes nothing for it", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "fully-scanned.pdf");
    const doc = getDocument(ctx, id)!;
    expect(doc.processingStatus).toBe("failed");
    expect(doc.failureNotes.join(" ")).toMatch(/scanned|image/i);
    const n = ctx.db.prepare("SELECT COUNT(*) c FROM passages WHERE doc_id=?").get(id) as { c: number };
    expect(n.c).toBe(0);
  });

  it("extracts title/author from PDF metadata and keeps passages page-bound with exact text", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "attention-budget.pdf");
    const doc = getDocument(ctx, id)!;
    expect(doc.title).toBe("The Attention Budget");
    expect(doc.author).toBe("Fixture Author");
    expect(doc.pageCount).toBe(3);

    const passages = ctx.db
      .prepare("SELECT id, page, start, end, text FROM passages WHERE doc_id=? ORDER BY page, ord")
      .all(id) as { page: number; start: number; end: number; text: string }[];
    expect(passages.length).toBeGreaterThanOrEqual(3);
    for (const p of passages) {
      const pageText = getPages(ctx, id).find((x) => x.page === p.page)!.text;
      expect(pageText.slice(p.start, p.end)).toBe(p.text);
    }
    const p2 = passages.filter((p) => p.page === 2).map((p) => p.text).join(" ");
    expect(p2).toContain("Attention is a scarce resource.");
  });

  it("detects paragraph breaks in PDFs", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "attention-budget.pdf");
    const page2 = getPages(ctx, id).find((p) => p.page === 2)!;
    expect(page2.text.split("\n\n").length).toBe(2);
  });

  it("imports markdown and uses its heading as the title", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "reading-notes.md");
    const doc = getDocument(ctx, id)!;
    expect(doc.kind).toBe("markdown");
    expect(doc.title).toBe("Reading Notes on Habits");
    expect(doc.processingStatus).toBe("ready");
  });

  it("is idempotent for the same file (content hash)", async () => {
    const ctx = setup();
    const a = await importFixture(ctx, "attention-budget.pdf");
    const b = await importFixture(ctx, "attention-budget.pdf");
    expect(b).toBe(a);
    expect(listDocuments(ctx).length).toBe(1);
  });

  it("rejects unsupported file types", () => {
    const ctx = setup();
    expect(() => kindFromName("photo.png")).toThrow(UnsupportedFileError);
    expect(() => importFile(ctx, { name: "a.docx", data: Buffer.from("x") })).toThrow(UnsupportedFileError);
  });

  it("fails cleanly on a corrupt PDF instead of crashing", async () => {
    const ctx = setup();
    const res = importFile(ctx, { name: "broken.pdf", data: Buffer.from("this is not a pdf") });
    await res.done;
    await idle(ctx);
    const doc = getDocument(ctx, res.document.id)!;
    expect(doc.processingStatus).toBe("failed");
    expect(doc.failureNotes[0]).toMatch(/Could not read/);
  });

  it("supports editing metadata and reading status, and refuses deleting a document that has knowledge", async () => {
    const ctx = setup();
    const id = await importFixture(ctx, "choices-and-trade-offs.pdf");
    const patched = patchDocument(ctx, id, { title: "My Title", readingStatus: "reading" })!;
    expect(patched.title).toBe("My Title");
    expect(patched.readingStatus).toBe("reading");

    ctx.db
      .prepare(
        `INSERT INTO units(type, content, doc_id, page, start, end, source_text, accepted_at)
         VALUES ('idea','x',?,1,0,1,'x','2026-01-01')`,
      )
      .run(id);
    expect(deleteDocument(ctx, id, false)).toEqual({ ok: false, unitCount: 1 });
    expect(deleteDocument(ctx, id, true).ok).toBe(true);
    expect(getDocument(ctx, id)).toBeNull();
  });
});
