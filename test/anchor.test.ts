import { describe, expect, it } from "vitest";
import { findSpan, makeAnchor, paragraphBounds, reanchor } from "../server/text/anchor.ts";
import { splitPassages, MAX_WORDS } from "../server/text/passages.ts";

const PAGE =
  "Attention is a scarce resource. Every notification draws on the same supply.\n\n" +
  "Context switching has a cost. Attention is a scarce resource when meetings multiply.";

describe("findSpan", () => {
  it("returns the page's own text, not the raw selection", () => {
    const s = findSpan(PAGE, "attention   is a\nscarce resource")!;
    expect(s.text).toBe("Attention is a scarce resource");
    expect(PAGE.slice(s.start, s.end)).toBe(s.text);
  });

  it("ignores quote style and whitespace differences", () => {
    const page = "He said \u201Cit\u2019s fine\u201D and left.";
    const s = findSpan(page, `"it's  fine"`)!;
    expect(s.text).toBe("\u201Cit\u2019s fine\u201D");
  });

  it("uses the hint to choose between repeated spans", () => {
    const first = findSpan(PAGE, "attention is a scarce resource", 0)!;
    const second = findSpan(PAGE, "attention is a scarce resource", 80)!;
    expect(first.occurrences).toBe(2);
    expect(second.start).toBeGreaterThan(first.start);
  });

  it("returns null when the text is not on the page", () => {
    expect(findSpan(PAGE, "something unrelated entirely")).toBeNull();
    expect(findSpan(PAGE, "   ")).toBeNull();
  });
});

describe("reanchor", () => {
  it("keeps the range when text is unchanged", () => {
    const a = makeAnchor(PAGE, 0, 30);
    expect(reanchor(PAGE, a)).toEqual({ start: 0, end: 30 });
  });

  it("uses prefix/suffix to pick the right repeat after the page text shifts", () => {
    const start = PAGE.lastIndexOf("Attention is a scarce resource");
    const a = makeAnchor(PAGE, start, start + 30);
    const shifted = "NEW HEADING LINE\n\n" + PAGE;
    const r = reanchor(shifted, a)!;
    expect(shifted.slice(r.start, r.end)).toBe("Attention is a scarce resource");
    expect(r.start).toBe(shifted.lastIndexOf("Attention is a scarce resource"));
  });

  it("returns null (stale) when the text is gone", () => {
    const a = makeAnchor(PAGE, 0, 30);
    expect(reanchor("Completely different page content.", a)).toBeNull();
  });
});

describe("paragraphBounds", () => {
  it("finds the paragraph around a span", () => {
    const start = PAGE.indexOf("Context");
    const b = paragraphBounds(PAGE, start, start + 5);
    expect(PAGE.slice(b.start, b.end).startsWith("Context switching")).toBe(true);
    expect(PAGE.slice(b.start, b.end)).not.toContain("Every notification");
  });
});

describe("splitPassages", () => {
  const words = (n: number, w = "alpha") => Array.from({ length: n }, () => w).join(" ");

  it("splits long paragraphs into <= MAX_WORDS chunks at sentence boundaries, never losing text", () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `${words(20, "w" + i)}.`).join(" ");
    const spans = splitPassages(sentences);
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      const t = sentences.slice(s.start, s.end);
      expect(t.split(/\s+/).length).toBeLessThanOrEqual(MAX_WORDS);
      expect(t.trim()).toBe(t);
    }
    // every sentence is fully contained in exactly one chunk
    for (let i = 0; i < 12; i++) {
      const needle = `w${i} `;
      expect(spans.filter((s) => sentences.slice(s.start, s.end).includes(needle)).length).toBe(1);
    }
  });

  it("hard-splits a single enormous sentence", () => {
    const text = words(250);
    const spans = splitPassages(text);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    expect(spans.every((s) => text.slice(s.start, s.end).split(/\s+/).length <= MAX_WORDS)).toBe(true);
  });

  it("merges short heading-like blocks into the next block", () => {
    const text = `Chapter One\n\n${words(30)}.`;
    const spans = splitPassages(text);
    expect(spans.length).toBe(1);
    expect(text.slice(spans[0].start, spans[0].end).startsWith("Chapter One")).toBe(true);
  });

  it("keeps separate paragraphs separate", () => {
    const text = `${words(20, "one")}.\n\n${words(20, "two")}.`;
    expect(splitPassages(text).length).toBe(2);
  });
});
