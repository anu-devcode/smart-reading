import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemsToPageText, type PdfItem } from "../server/ingest/layout.ts";
import { getPages } from "../server/library.ts";
import { search } from "../server/search/search.ts";
import { importFixture, tempCtx } from "./helpers.ts";

const H = 11;
const CHAR = 5.2;
function item(str: string, x: number, y: number): PdfItem {
  return { str, transform: [1, 0, 0, 1, x, y], width: str.length * CHAR, height: H };
}

/** lines of one column starting at x, 14pt apart from yTop; "" leaves a blank line (paragraph gap) */
function column(lines: string[], x: number, yTop: number): PdfItem[] {
  return lines.flatMap((s, i) => (s ? [item(s, x, yTop - i * 14)] : []));
}

/**
 * Row-by-row interleaved order, the way many PDFs store columns. Like pdf.js, a whitespace item that
 * spans the whole gap is emitted between the two lines of a row.
 */
function interleave(a: PdfItem[], b: PdfItem[]): PdfItem[] {
  const out: PdfItem[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (a[i] && b[i]) {
      const end = a[i].transform[4] + a[i].width;
      out.push({ str: " ", transform: [1, 0, 0, 1, end, a[i].transform[5]], width: b[i].transform[4] - end, height: 0 });
    }
    if (b[i]) out.push(b[i]);
  }
  return out;
}

const LEFT = [
  "Tide pools form where rock basins",
  "hold seawater after the sea has",
  "gone out. The water warms and",
  "salts up over a few hours.",
  "",
  "Zonation is the first thing a",
  "visitor notices. The pools at the",
  "lowest edge are home to",
];
const RIGHT = [
  "anemones, hermit crabs and small",
  "fish that never leave.",
  "",
  "Predators arrive with the tide.",
  "Sea stars pry open mussels slowly",
  "and a single star can clear a",
  "whole rock face over a season.",
  "Barnacles close their shells.",
];

describe("single column", () => {
  it("reads rows top to bottom and splits paragraphs on large gaps", () => {
    const items = column(["First line of a para-", "graph that continues here.", "", "Second paragraph starts here.", "and ends here."], 72, 700);
    expect(itemsToPageText(items)).toBe(
      "First line of a para- graph that continues here.\n\nSecond paragraph starts here. and ends here.",
    );
  });
  it("does not mistake a ragged right edge for columns", () => {
    const lens = [60, 41, 58, 22, 57, 33, 59, 48, 60, 12];
    const items = lens.map((n, i) => item("x".repeat(n), 72, 700 - i * 14));
    expect(itemsToPageText(items)).toBe(lens.map((n) => "x".repeat(n)).join(" "));
  });
  it("does not mistake an indented block for columns", () => {
    const items = [
      ...column(["Intro line one runs the full width of the page here in this test", "Intro line two runs the full width of the page here in this test"], 72, 700),
      ...column(["An indented quotation that sits in the middle", "of the text and is much narrower", "than the paragraphs around it.", "Back to wide text for the remaining part of the page, full width ok"], 160, 672),
    ];
    const text = itemsToPageText(items);
    expect(text.indexOf("Intro line one")).toBeLessThan(text.indexOf("An indented"));
    expect(text.indexOf("An indented")).toBeLessThan(text.indexOf("of the text"));
  });
});

describe("two columns", () => {
  const items = interleave(column(LEFT, 72, 700), column(RIGHT, 330, 700));
  const text = itemsToPageText(items);

  it("reads the left column completely, then the right", () => {
    expect(text.indexOf("hold seawater")).toBeLessThan(text.indexOf("gone out"));
    expect(text.indexOf("lowest edge")).toBeLessThan(text.indexOf("anemones"));
    expect(text.indexOf("anemones")).toBeLessThan(text.indexOf("Predators"));
    // nothing from the right column leaks into the left one
    expect(text.slice(0, text.indexOf("anemones"))).not.toContain("Predators");
    expect(text.slice(0, text.indexOf("anemones"))).not.toContain("hermit");
  });

  it("joins a sentence that continues from the bottom of one column to the top of the next", () => {
    expect(text).toContain("are home to anemones, hermit crabs");
  });

  it("keeps paragraph breaks inside a column", () => {
    expect(text).toContain("over a few hours.\n\nZonation");
    expect(text).toContain("never leave.\n\nPredators");
  });

  it("treats a full-width heading as its own paragraph and reads columns below it", () => {
    const heading = item("Field Notes on Tide Pools and Other Places", 72, 740);
    const t = itemsToPageText([heading, ...items]);
    expect(t.startsWith("Field Notes on Tide Pools and Other Places\n\nTide pools form")).toBe(true);
    expect(t.indexOf("anemones")).toBeGreaterThan(t.indexOf("lowest edge"));
  });

  it("starts a new paragraph at a column change when the previous column ended a sentence", () => {
    const left = column(["A column that ends its sentence.", "It has several lines of text", "so it looks like real prose", "and stays well inside.", "One more line for good measure.", "And another one here.", "A line to make nine rows.", "Final line of this column."], 72, 700);
    const right = column(["The second column starts a new sentence.", "More lines follow it here", "to fill out the column", "with similar width of text", "and a few extra lines", "so the layout is clear.", "One more for good measure.", "Last line of right column."], 330, 700);
    const t = itemsToPageText(interleave(left, right));
    expect(t).toContain("Final line of this column.\n\nThe second column");
  });
});

describe("two-column PDF fixture", () => {
  let ctx: ReturnType<typeof tempCtx>["ctx"];
  let cleanup: () => void;
  beforeEach(() => ({ ctx, cleanup } = tempCtx()));
  afterEach(() => cleanup());

  it("is imported in reading order, with the single-column control page unchanged", async () => {
    const id = await importFixture(ctx, "tide-pools.pdf");
    const pages = getPages(ctx, id);
    expect(pages).toHaveLength(3);
    expect(pages[0].text).toContain("swings that would kill most sea creatures");
    expect(pages[0].text).toContain("are home to anemones, hermit crabs and small fish that never leave");
    expect(pages[0].text).toContain("close their shells to wait out the dry hours");
    expect(pages[0].text.startsWith("Field Notes on Tide Pools")).toBe(true);
    expect(pages[2].text).toContain("Summary");
    expect(pages[2].text).toContain("Short notes.");
    expect(pages[2].text.indexOf("Summary")).toBeLessThan(pages[2].text.indexOf("A reader who visits"));
  });

  it("can be searched by phrases that only exist when the columns are read correctly", async () => {
    await importFixture(ctx, "tide-pools.pdf");
    for (const q of ['"home to anemones"', '"swings that would kill most sea creatures"', '"lowest tide of the month"']) {
      const r = await search(ctx, q);
      expect(r.passages.length, q).toBeGreaterThan(0);
    }
  });
});
