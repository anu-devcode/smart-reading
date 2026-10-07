import { afterEach, describe, expect, it } from "vitest";
import { RELATIONS, UNIT_TYPES } from "../shared/types.ts";
import { importFixture, tempCtx } from "./helpers.ts";

describe("the knowledge model is fixed", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("has exactly four unit types and three relations", () => {
    expect(UNIT_TYPES).toEqual(["quote", "idea", "concept", "question"]);
    expect(RELATIONS).toEqual(["same_idea", "supports", "contradicts"]);
  });

  it("the library itself refuses other types, other relations, and units without a source", async () => {
    const t = tempCtx();
    cleanup = t.cleanup;
    const docId = await importFixture(t.ctx, "attention-budget.pdf");
    const now = new Date().toISOString();
    const insert = (type: string, page: unknown, sourceText: unknown) =>
      t.ctx.db
        .prepare("INSERT INTO units(type, content, doc_id, page, start, end, source_text, accepted_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(type, "x", docId, page, 0, 1, sourceText, now);

    expect(() => insert("tag", 1, "M")).toThrow(/CHECK/);
    expect(() => insert("idea", null, "M")).toThrow(/NOT NULL/);
    expect(() => insert("idea", 1, null)).toThrow(/NOT NULL/);
    expect(() =>
      t.ctx.db.prepare("INSERT INTO units(type, content, doc_id, page, start, end, source_text, accepted_at) VALUES ('idea','x',999,1,0,1,'M',?)").run(now),
    ).toThrow(/FOREIGN KEY/);

    const a = Number(insert("idea", 1, "M").lastInsertRowid);
    const b = Number(insert("question", 1, "M").lastInsertRowid);
    expect(() => t.ctx.db.prepare("INSERT INTO unit_links(from_id, to_id, relation, created_at) VALUES (?,?,?,?)").run(a, b, "related_to", now)).toThrow(/CHECK/);
  });
});
