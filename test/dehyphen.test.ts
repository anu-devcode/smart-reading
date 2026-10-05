import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forIndex } from "../server/text/dehyphen.ts";
import { importFile } from "../server/ingest/pipeline.ts";
import { search } from "../server/search/search.ts";
import { createUnit } from "../server/knowledge/units.ts";
import { getPages } from "../server/library.ts";
import { idle } from "../server/context.ts";
import { tempCtx } from "./helpers.ts";

describe("forIndex", () => {
  it("joins a word broken at a line end", () => {
    expect(forIndex("an inter- national agreement")).toBe("an international agreement");
    expect(forIndex("an inter-\nnational agreement")).toBe("an international agreement");
  });
  it("leaves typed hyphens, numbers and spaced dashes alone", () => {
    expect(forIndex("a well-known fact")).toBe("a well-known fact");
    expect(forIndex("pages 10- 12")).toBe("pages 10- 12");
    expect(forIndex("this - that")).toBe("this - that");
    expect(forIndex("Berlin- Munich route")).toBe("Berlin- Munich route"); // next word is capitalised
  });
});

describe("hyphen-split words in a real import", () => {
  let ctx: ReturnType<typeof tempCtx>["ctx"];
  let cleanup: () => void;
  beforeEach(() => ({ ctx, cleanup } = tempCtx()));
  afterEach(() => cleanup());

  const body = "The negotiators signed an inter-\nnational agreement on shared water. Nothing else changed that year.";

  it("finds the word by keyword, while the stored text keeps the original characters", async () => {
    const res = importFile(ctx, { name: "treaty.txt", data: Buffer.from(body, "utf8") });
    await res.done;
    await idle(ctx);

    const r = await search(ctx, "international");
    expect(r.passages).toHaveLength(1);

    const page = getPages(ctx, res.document.id)[0].text;
    expect(page).toContain("inter-");
    expect(r.passages[0].text).toBe(page.slice(r.passages[0].start, r.passages[0].end));
  });

  it("a quote across the break is still the exact source text", async () => {
    const res = importFile(ctx, { name: "treaty.txt", data: Buffer.from(body, "utf8") });
    await res.done;
    const page = getPages(ctx, res.document.id)[0].text;
    const { unit } = await createUnit(ctx, {
      type: "quote",
      docId: res.document.id,
      page: 1,
      selectionText: "signed an inter- national agreement",
    });
    expect(page.slice(unit.start, unit.end)).toBe(unit.content);
    const r = await search(ctx, "international agreement");
    expect(r.saved.units.some((u) => u.unit.id === unit.id)).toBe(true);
  });
});
