import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVocab, forIndex, indexVariants } from "../server/text/dehyphen.ts";
import { openDb, SCHEMA_V1, SCHEMA_VERSION } from "../server/db.ts";
import { importFile } from "../server/ingest/pipeline.ts";
import { search } from "../server/search/search.ts";
import { createUnit } from "../server/knowledge/units.ts";
import { getPages } from "../server/library.ts";
import { idle } from "../server/context.ts";
import { tempCtx } from "./helpers.ts";

describe("indexVariants", () => {
  it("joins a word broken at a line end and keeps the split reading as an alternative", () => {
    const v = indexVariants("an inter- national agreement");
    expect(v.body).toBe("an international agreement");
    expect(v.alt).toBe("inter national");
  });
  it("treats the break as a compound when the document types the hyphenated form elsewhere", () => {
    const vocab = buildVocab(["a well-known fact", "the well- known author"]);
    const v = indexVariants("the well- known author", vocab);
    expect(v.body).toBe("the well-known author");
    expect(v.alt).toBe("wellknown");
  });
  it("treats the break as soft when the document uses the joined word elsewhere", () => {
    const vocab = buildVocab(["international law", "an inter- national deal"]);
    expect(indexVariants("an inter- national deal", vocab).body).toBe("an international deal");
  });
  it("leaves typed hyphens, numbers, spaced dashes and capitalised next words alone", () => {
    for (const s of ["a well-known fact", "pages 10- 12", "this - that", "Berlin- Munich route"]) {
      expect(indexVariants(s)).toEqual({ body: s, alt: "" });
    }
  });
  it("forIndex is the vocabulary-free join", () => {
    expect(forIndex("an inter-\nnational agreement")).toBe("an international agreement");
  });
});

describe("hyphen-split words in a real import", () => {
  let ctx: ReturnType<typeof tempCtx>["ctx"];
  let cleanup: () => void;
  beforeEach(() => ({ ctx, cleanup } = tempCtx()));
  afterEach(() => cleanup());

  const soft = "The negotiators signed an inter-\nnational agreement on shared water. Nothing else changed that year.";
  const compound = "Everyone called her a well-\nknown critic. Earlier reviews had named him a well-known poet too.";

  it("finds a soft-hyphen word by its joined form, while the stored text keeps the original characters", async () => {
    const res = importFile(ctx, { name: "treaty.txt", data: Buffer.from(soft, "utf8") });
    await res.done;
    await idle(ctx);
    const r = await search(ctx, "international");
    expect(r.passages).toHaveLength(1);
    const page = getPages(ctx, res.document.id)[0].text;
    expect(page).toContain("inter-");
    expect(r.passages[0].text).toBe(page.slice(r.passages[0].start, r.passages[0].end));
  });

  it("a soft-hyphen word is still findable by its pieces", async () => {
    const res = importFile(ctx, { name: "treaty.txt", data: Buffer.from(soft, "utf8") });
    await res.done;
    expect((await search(ctx, "inter national")).passages).toHaveLength(1);
  });

  it("a real compound broken at a line end is found as its two words AND as the joined word", async () => {
    const res = importFile(ctx, { name: "reviews.txt", data: Buffer.from(compound, "utf8") });
    await res.done;
    const r = await search(ctx, "well known critic");
    expect(r.passages.length).toBeGreaterThan(0);
    expect((await search(ctx, '"well-known critic"')).passages).toHaveLength(1);
    expect((await search(ctx, "wellknown")).passages).toHaveLength(1);
  });

  it("a quote across the break is still the exact source text", async () => {
    const res = importFile(ctx, { name: "treaty.txt", data: Buffer.from(soft, "utf8") });
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


describe("migration from schema v1", () => {
  it("upgrades a v1 library: the passage index gains the alt column and old text stays searchable", () => {
    const dir = mkdtempSync(join(tmpdir(), "smart-reading-mig-"));
    try {
      const file = join(dir, "library.db");
      const old = new Database(file);
      old.exec(SCHEMA_V1);
      old.pragma("user_version = 1");
      const text = "They signed an inter- national treaty.";
      old
        .prepare(
          "INSERT INTO documents(id,title,kind,original_name,stored_name,content_hash,added_at) VALUES (1,'T','text','t.txt','t.txt','h','2026-01-01')",
        )
        .run();
      old.prepare("INSERT INTO pages VALUES (1,1,?, 'ok')").run(text);
      old.prepare("INSERT INTO passages VALUES (1,1,1,0,0,?,?)").run(text.length, text);
      old.prepare("INSERT INTO passages_fts(rowid, body) VALUES (1,?)").run(text);
      old.close();

      const db = openDb(file); // runs migration v2 and re-indexes
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) c FROM ocr_pages").get()).toEqual({ c: 0 });
      expect(db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH 'international'").all()).toHaveLength(1);
      expect(db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH 'treaty'").all()).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
