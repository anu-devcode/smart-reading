import { describe, expect, it } from "vitest";
import { citationText } from "../shared/types.ts";

const base = { docTitle: "The Attention Budget", docAuthor: "A. Writer", docYear: 2021, page: 2, endPage: 2 };

describe("copy with citation", () => {
  it("puts a quote in quotation marks, followed by its source", () => {
    expect(citationText({ ...base, type: "quote", content: "Attention is a scarce resource." })).toBe(
      "\u201CAttention is a scarce resource.\u201D \u2014 A. Writer, The Attention Budget (2021), p. 2",
    );
  });

  it("keeps your own words as they are and names the source on the next line", () => {
    expect(citationText({ ...base, type: "idea", content: "Every interruption costs focus." })).toBe(
      "Every interruption costs focus.\n(A. Writer, The Attention Budget (2021), p. 2)",
    );
  });

  it("works without author or year, and for a span over pages", () => {
    expect(citationText({ ...base, docAuthor: null, docYear: null, endPage: 3, type: "quote", content: "end of one page\n\nstart of the next" })).toBe(
      "\u201Cend of one page start of the next\u201D \u2014 The Attention Budget, pp. 2\u20133",
    );
  });
});
