import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUnit, getUnitContext } from "../server/knowledge/units.ts";
import { createHighlight, listHighlights } from "../server/knowledge/highlights.ts";
import { distillSelection, type DistillProvider } from "../server/knowledge/distill.ts";
import { buildExport, buildMarkdown } from "../server/knowledge/export.ts";
import { reprocessDocument } from "../server/ingest/pipeline.ts";
import { getPages } from "../server/library.ts";
import { search } from "../server/search/search.ts";
import { importFile } from "../server/ingest/pipeline.ts";
import { importFixture, tempCtx } from "./helpers.ts";
import { PAGE_JOIN } from "../shared/types.ts";

describe("selections that cross pages", () => {
  let ctx: ReturnType<typeof tempCtx>["ctx"];
  let cleanup: () => void;
  let docId: number;
  let p: string[]; // page texts, 0-based

  beforeEach(async () => {
    ({ ctx, cleanup } = tempCtx());
    docId = await importFixture(ctx, "attention-budget.pdf");
    p = getPages(ctx, docId).map((x) => x.text);
  });
  afterEach(() => cleanup());

  const tailOfPage1 = "produced little finished work.";
  const headOfPage2 = "Attention is a scarce resource.";

  it("keeps a quote that starts on one page and ends on the next, as the exact text of both", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote",
      docId,
      page: 1,
      selectionText: tailOfPage1,
      endPage: 2,
      endText: headOfPage2,
    });
    expect(unit.page).toBe(1);
    expect(unit.endPage).toBe(2);
    expect(unit.content).toBe(p[0].slice(unit.start) + PAGE_JOIN + p[1].slice(0, unit.end));
    expect(unit.content.startsWith(tailOfPage1)).toBe(true);
    expect(unit.content.endsWith(headOfPage2)).toBe(true);
    // each side really is a piece of its own page
    const [a, b] = unit.content.split(PAGE_JOIN);
    expect(p[0].endsWith(a)).toBe(true);
    expect(p[1].startsWith(b)).toBe(true);
  });

  it("includes every page in between, whole", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote",
      docId,
      page: 1,
      selectionText: tailOfPage1,
      endPage: 3,
      endText: "Context switching has a cost that outlasts the interruption itself.",
    });
    expect(unit.endPage).toBe(3);
    expect(unit.content).toBe(p[0].slice(unit.start) + PAGE_JOIN + p[1] + PAGE_JOIN + p[2].slice(0, unit.end));
  });

  it("writes an idea tied to a multi-page source and stores the same highlight once", async () => {
    const sel = { docId, page: 1, selectionText: tailOfPage1, endPage: 2, endText: headOfPage2 };
    const a = await createUnit(ctx, { type: "idea", content: "Busy days leave little finished work.", ...sel });
    expect(a.unit.endPage).toBe(2);
    expect(a.unit.sourceText).toBe(p[0].slice(a.unit.start) + PAGE_JOIN + p[1].slice(0, a.unit.end));
    await createUnit(ctx, { type: "quote", ...sel });
    await createHighlight(ctx, sel);
    const hs = listHighlights(ctx, docId).filter((h) => h.endPage === 2);
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe(a.unit.sourceText);
  });

  it("is found by words from either side and shows both pages in its context", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote", docId, page: 1, selectionText: tailOfPage1, endPage: 2, endText: headOfPage2,
    });
    for (const q of ["finished work", "scarce resource"]) {
      const r = await search(ctx, q);
      expect(r.saved.units.some((u) => u.unit.id === unit.id), q).toBe(true);
    }
    const c = getUnitContext(ctx, unit.id);
    expect(c.paragraph).toContain("a day that felt busy");
    expect(c.paragraph).toContain("Attention is a scarce resource");
    expect(c.paragraph.indexOf("busy")).toBeLessThan(c.paragraph.indexOf("scarce"));
  });

  it("rejects selections it cannot make sense of", async () => {
    const base = { type: "quote" as const, docId, page: 2, selectionText: headOfPage2 };
    await expect(createUnit(ctx, { ...base, endPage: 1, endText: tailOfPage1 })).rejects.toThrow(/before it starts/);
    await expect(createUnit(ctx, { ...base, endPage: 3 })).rejects.toThrow(/endText is required/);
    await expect(createUnit(ctx, { ...base, endPage: 3, endText: "words that are not on that page" })).rejects.toThrow(/Could not match/);
    await expect(createUnit(ctx, { ...base, endPage: 40, endText: "x" })).rejects.toThrow();
  });

  it("limits how many pages one span may cover", async () => {
    const { ctx: c2, cleanup: done } = tempCtx();
    try {
      // text files are split into virtual pages of ~2500 characters, so long paragraphs give many pages
      const filler = "word ".repeat(520);
      const text = Array.from({ length: 8 }, (_, i) => `Page ${i + 1} has a sentence that is easy to find. ${filler}`).join("\n\n");
      const res = importFile(c2, { name: "long.txt", data: Buffer.from(text, "utf8") });
      await res.done;
      const n = getPages(c2, res.document.id).length;
      expect(n).toBeGreaterThanOrEqual(7);
      await expect(
        createUnit(c2, {
          type: "quote", docId: res.document.id, page: 1, selectionText: "Page 1 has a sentence",
          endPage: n, endText: `Page ${n} has a sentence`,
        }),
      ).rejects.toThrow(/at most 5 pages/);
    } finally {
      done();
    }
  });

  it("distills across a page break, verifying evidence against both pages", async () => {
    const provider: DistillProvider = {
      distill: async () => [
        { type: "idea", text: "Busy days produce little.", supportingQuote: "a day that felt busy but produced little finished work" },
        { type: "idea", text: "Attention is limited.", supportingQuote: "Attention is a scarce resource" },
        { type: "idea", text: "Made up", supportingQuote: "this text is nowhere in the document" },
      ],
    };
    const r = await distillSelection(ctx, provider, {
      docId, page: 1, selectionText: tailOfPage1, endPage: 2, endText: headOfPage2,
    });
    expect(r.candidates).toHaveLength(2);
    expect(r.dropped).toBe(1);
    expect(r.anchor.page).toBe(1);
    expect(r.anchor.endPage).toBe(2);
  });

  it("is exported with both pages", async () => {
    await createUnit(ctx, { type: "quote", docId, page: 1, selectionText: tailOfPage1, endPage: 2, endText: headOfPage2 });
    const u = buildExport(ctx).units[0];
    expect(u.source.page).toBe(1);
    expect(u.source.endPage).toBe(2);
    expect(buildMarkdown(ctx)).toContain("pp. 1\u20132");
  });

  it("survives re-processing while the text is unchanged", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote", docId, page: 1, selectionText: tailOfPage1, endPage: 2, endText: headOfPage2,
    });
    await reprocessDocument(ctx, docId);
    expect(listHighlights(ctx, docId).find((h) => h.endPage === 2)?.stale).toBe(false);
    expect(getUnitContext(ctx, unit.id).unit.endPage).toBe(2);
  });
});
