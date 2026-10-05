import { describe, expect, it } from "vitest";
import { markedTerms, parseQuery } from "../server/search/query.ts";

describe("parseQuery", () => {
  it("quotes plain words and joins them with an explicit AND", () => {
    const p = parseQuery("attention scarce");
    expect(p.bodyExpr).toBe('"attention" AND "scarce"');
    expect(p.structured).toBe(false);
    expect(p.orExpr).toBe('"attention" OR "scarce"');
  });

  it("treats a quoted phrase as one structured term", () => {
    const p = parseQuery('"scarce resource" attention');
    expect(p.bodyExpr).toBe('"scarce resource" AND "attention"');
    expect(p.phrases).toEqual(["scarce resource"]);
    expect(p.structured).toBe(true);
    expect(p.orExpr).toContain('"scarce resource"');
  });

  it("supports uppercase AND / OR / NOT and parentheses", () => {
    expect(parseQuery("forgetting AND intervals").bodyExpr).toBe('"forgetting" AND "intervals"');
    expect(parseQuery("memory NOT cramming").bodyExpr).toBe('"memory" NOT "cramming"');
    expect(parseQuery("(a OR b) AND c").bodyExpr).toBe('("a" OR "b") AND "c"');
    expect(parseQuery("memory NOT cramming").structured).toBe(true);
  });

  it("treats lowercase and/or/not as ordinary words", () => {
    expect(parseQuery("cats and dogs").bodyExpr).toBe('"cats" AND "and" AND "dogs"');
  });

  it("never produces a dangling operator, a leading NOT, or unbalanced parentheses", () => {
    expect(parseQuery("alpha AND").bodyExpr).toBe('"alpha"');
    expect(parseQuery("NOT alpha").bodyExpr).toBe('"alpha"');
    expect(parseQuery("alpha AND OR beta").bodyExpr).toBe('"alpha" AND "beta"');
    expect(parseQuery("(alpha beta").bodyExpr).toBe('"alpha" AND "beta"');
    expect(parseQuery("alpha) beta").bodyExpr).toBe('"alpha" AND "beta"');
    expect(parseQuery("() alpha").bodyExpr).toBe('"alpha"');
    expect(parseQuery("( AND ) alpha").bodyExpr).toBe('"alpha"');
  });

  it("neutralises punctuation that would break FTS5", () => {
    const p = parseQuery(`what's up? foo-bar: baz* "unterminated`);
    expect(p.bodyExpr).toContain('"what\'s up"'.slice(0, 7)); // contains "what's
    expect(p.bodyExpr).not.toMatch(/[?:]/);
    expect(p.bodyExpr).toContain('"baz"*');
    expect(p.structured).toBe(true); // prefix + phrase
  });

  it("extracts field scopes and filters", () => {
    const p = parseQuery("title:complexity author:smith type:ideas status:unread kind:pdf attention");
    expect(p.docExpr).toBe('title:"complexity" AND author:"smith"');
    expect(p.filters).toEqual({ type: "idea", status: "unread", kind: "pdf" });
    expect(p.bodyExpr).toBe('"attention"');
    expect(parseQuery("note:revisit").noteExpr).toBe('note:"revisit"');
  });

  it("supports a quoted value after a field name", () => {
    expect(parseQuery('title:"systems and complexity"').docExpr).toBe('title:"systems and complexity"');
  });

  it("ignores invalid filter values and empty queries", () => {
    expect(parseQuery("type:nonsense").filters).toEqual({});
    const e = parseQuery("   ");
    expect(e.bodyExpr).toBeNull();
    expect(e.semanticText).toBe("");
  });

  it("drops stopwords only in the OR fallback", () => {
    const p = parseQuery("why do big programs get harder to modify");
    expect(p.bodyExpr).toContain('"why" AND "do"');
    expect(p.orExpr).not.toContain('"why"');
    expect(p.orExpr).toContain('"programs"');
  });

  it("builds semantic text from words and phrase contents only", () => {
    expect(parseQuery('title:foo "scarce resource" attention AND focus type:idea').semanticText).toBe(
      "scarce resource attention focus",
    );
  });
});

describe("markedTerms", () => {
  it("collects highlighted terms from a snippet", () => {
    expect(markedTerms("a \u0001Scarce\u0002 b \u0001resource\u0002 \u0001scarce\u0002")).toEqual(["scarce", "resource"]);
  });
});
