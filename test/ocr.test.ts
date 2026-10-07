import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.ts";
import { writeOcrSettings } from "../server/config.ts";
import { idle } from "../server/context.ts";
import { buildOcrPage, MIN_PAGE_CONFIDENCE, type OcrEngine, type RawPage } from "../server/ingest/ocr.ts";
import { reprocessDocument } from "../server/ingest/pipeline.ts";
import { createHighlight } from "../server/knowledge/highlights.ts";
import { getDocument, getPages } from "../server/library.ts";
import { search } from "../server/search/search.ts";
import type { OcrWordDto } from "../shared/types.ts";
import { importFixture, tempCtx } from "./helpers.ts";

/** A page of text as an OCR engine would report it: `null` is a blank line. */
function raw(lines: (string | null)[], confidence = 92): RawPage {
  const blocks: RawPage["blocks"] = [{ lines: [] }];
  let y = 100;
  for (const line of lines) {
    if (line === null) {
      y += 60;
      continue;
    }
    let x = 80;
    blocks[0].lines.push(
      line.split(" ").map((text) => {
        const w = { text, confidence, x0: x, y0: y, x1: x + text.length * 12, y1: y + 24 };
        x += text.length * 12 + 12;
        return w;
      }),
    );
    y += 40;
  }
  return { width: 1000, height: 1400, blocks };
}

/** Answers each page in turn from a script; past the end it reports an empty page. */
class FakeOcr implements OcrEngine {
  calls = 0;
  fail: string | null = null;
  constructor(private replies: RawPage[]) {}
  async recognize(): Promise<RawPage> {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    return this.replies[this.calls - 1] ?? { width: 1000, height: 1400, blocks: [] };
  }
  async close() {}
}

describe("turning engine output into a page", () => {
  it("builds the page text and gives every word its place in it", () => {
    const r = buildOcrPage(raw(["Attention is a scarce resource.", "Every notification draws on supply.", null, "A second paragraph begins here."]));
    expect(r.status).toBe("ok");
    expect(r.text).toBe("Attention is a scarce resource.\nEvery notification draws on supply.\n\nA second paragraph begins here.");
    expect(r.words.map((w) => r.text.slice(w.s, w.e)).join(" ")).toBe(r.text.replace(/\s+/g, " "));
    for (const w of r.words) {
      for (const v of [w.x0, w.y0, w.x1, w.y1]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [w.x0, w.y0, w.x1, w.y1]) expect(v).toBeLessThanOrEqual(1);
      expect(w.x1).toBeGreaterThan(w.x0);
    }
  });

  it("leaves out words the engine itself is very unsure about", () => {
    const page = raw(["The quick brown fox jumps over the lazy dog today."]);
    page.blocks[0].lines[0][3].confidence = 10; // "fox"
    const r = buildOcrPage(page);
    expect(r.status).toBe("ok");
    expect(r.text).not.toContain("fox");
    expect(r.text).toContain("brown jumps");
  });

  it("rejects a page it is not sure about, with the reason, instead of guessing", () => {
    const r = buildOcrPage(raw(["Xq vbn lkj hgf dsa poi uyt rew qaz wsx edc"], MIN_PAGE_CONFIDENCE - 20));
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/uncertain/);
    expect(r.text).toBe("");
    expect(r.words).toEqual([]);
  });

  it("rejects a page with nothing readable on it", () => {
    expect(buildOcrPage({ width: 100, height: 100, blocks: [] })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no readable text/) });
    expect(buildOcrPage(raw(["| - ~"]))).toMatchObject({ status: "rejected" });
  });
});

describe("reading scanned pages in the background", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  const SCANNED = "Appendix scanned page. The warranty period covers parts and labour for two years.";

  it("makes a scanned page searchable, marks it as OCR, and says so", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");

    expect(engine.calls).toBe(1); // only the page without text was sent
    const pages = getPages(t.ctx, id);
    expect(pages.map((p) => [p.status, p.ocr])).toEqual([["ok", false], ["ok", true], ["ok", false]]);
    expect(pages[1].text).toBe(SCANNED);

    const doc = getDocument(t.ctx, id)!;
    expect(doc.processingStatus).toBe("ready");
    expect(doc.ocrPending).toBe(0);
    expect(doc.failureNotes.join(" ")).toMatch(/Page 2 was read from the page image with OCR and may contain recognition mistakes/);

    const r = await search(t.ctx, "warranty");
    expect(r.passages.some((p) => p.docId === id && p.page === 2)).toBe(true);
  });

  it("keeps real text and never sends it to OCR", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "attention-budget.pdf");
    expect(engine.calls).toBe(0);
    expect(getPages(t.ctx, id).every((p) => !p.ocr)).toBe(true);
    expect(getDocument(t.ctx, id)!.processingStatus).toBe("ready");
  });

  it("does not guess: unreadable pages stay unreadable, with the reason", async () => {
    const engine = new FakeOcr([raw(["Xq vbn lkj hgf dsa poi uyt rew qaz wsx edc"], 30)]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    const doc = getDocument(t.ctx, id)!;
    expect(doc.processingStatus).toBe("partial");
    expect(doc.failureNotes.join(" ")).toMatch(/OCR could not read page 2: the recognised text was too uncertain to trust/);
    expect(getPages(t.ctx, id)[1]).toMatchObject({ status: "empty", ocr: false, text: "" });
    expect((await search(t.ctx, "xq vbn")).passages).toEqual([]);
  });

  it("a document with nothing readable at all still fails honestly", async () => {
    const engine = new FakeOcr([]); // reports no text for every page
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "fully-scanned.pdf");
    expect(engine.calls).toBe(2);
    const doc = getDocument(t.ctx, id)!;
    expect(doc.processingStatus).toBe("failed");
    expect(doc.failureNotes.join(" ")).toMatch(/No text could be extracted/);
    expect(doc.failureNotes.join(" ")).toMatch(/OCR could not read pages 1-2: no readable text was found\. Those pages/);
  });

  it("reprocessing a document keeps what OCR read and does not read it again", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    await reprocessDocument(t.ctx, id);
    await idle(t.ctx);
    expect(engine.calls).toBe(1);
    expect(getPages(t.ctx, id)[1]).toMatchObject({ status: "ok", ocr: true, text: SCANNED });
    expect(getDocument(t.ctx, id)!.processingStatus).toBe("ready");
  });

  it("a quote from an OCR page is exactly that page's text", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    const h = createHighlight(t.ctx, { docId: id, page: 2, selectionText: "warranty   period covers parts" });
    expect(h.text).toBe("warranty period covers parts");
    expect(getPages(t.ctx, id)[1].text.slice(h.start, h.end)).toBe(h.text);
  });

  it("with OCR switched off, scanned pages are reported as such and nothing is read", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    writeOcrSettings(t.ctx.cfg, { enabled: false });
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    expect(engine.calls).toBe(0);
    const doc = getDocument(t.ctx, id)!;
    expect(doc.processingStatus).toBe("partial");
    expect(doc.ocrPending).toBe(0);
    expect(doc.failureNotes.join(" ")).toMatch(/Turn on OCR in Settings/);

    // switching it on reads the waiting pages
    writeOcrSettings(t.ctx.cfg, { enabled: true });
    await t.ctx.ocrJob.retry();
    await idle(t.ctx);
    expect(engine.calls).toBe(1);
    expect(getDocument(t.ctx, id)!.processingStatus).toBe("ready");
  });

  it("when the engine cannot run, the document says why and can be retried", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    engine.fail = "language data could not be downloaded";
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    expect(t.ctx.ocrJob.state).toBe("unavailable");
    const doc = getDocument(t.ctx, id)!;
    expect(doc.processingStatus).toBe("partial");
    expect(doc.ocrPending).toBe(0);
    expect(doc.failureNotes.join(" ")).toMatch(/OCR could not run: language data could not be downloaded/);

    engine.fail = null;
    engine.calls = 0;
    await t.ctx.ocrJob.retry();
    await idle(t.ctx);
    expect(t.ctx.ocrJob.state).not.toBe("unavailable");
    expect(getDocument(t.ctx, id)!.processingStatus).toBe("ready");
  });

  it("exposes word boxes only for pages that were read with OCR", async () => {
    const engine = new FakeOcr([raw([SCANNED])]);
    const t = tempCtx({ ocr: engine });
    cleanup = t.cleanup;
    const id = await importFixture(t.ctx, "partly-scanned.pdf");
    const app = await buildApp(t.ctx);
    const ok = await app.inject({ url: `/api/documents/${id}/pages/2/ocr-layout` });
    expect(ok.statusCode).toBe(200);
    const words = (ok.json() as { words: OcrWordDto[] }).words;
    const text = getPages(t.ctx, id)[1].text;
    expect(words.map((w) => text.slice(w.s, w.e)).join(" ")).toBe(text);
    expect((await app.inject({ url: `/api/documents/${id}/pages/1/ocr-layout` })).statusCode).toBe(404);
    await app.close();
  });
});
