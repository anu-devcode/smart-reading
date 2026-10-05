import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../server/context.ts";
import { createContext } from "../server/context.ts";
import { loadConfig, writeAiSettings } from "../server/config.ts";
import { createUnit, createLink, deleteUnit, getUnitContext, updateUnit } from "../server/knowledge/units.ts";
import { createHighlight, listHighlights } from "../server/knowledge/highlights.ts";
import { verifyCandidates, distillSelection, type DistillProvider } from "../server/knowledge/distill.ts";
import { reprocessDocument } from "../server/ingest/pipeline.ts";
import { buildExport, buildMarkdown } from "../server/knowledge/export.ts";
import { createBackup, restoreBackup } from "../server/backup.ts";
import { buildApp } from "../server/app.ts";
import { search } from "../server/search/search.ts";
import { getPageText } from "../server/library.ts";
import { FakeEmbedder, importFixture, tempCtx } from "./helpers.ts";

let ctx: Ctx;
let cleanup: () => void;
let docId: number;

const SCARCE = "Attention is a scarce resource.";

beforeEach(async () => {
  const t = tempCtx({ embedder: new FakeEmbedder() });
  ctx = t.ctx;
  cleanup = t.cleanup;
  docId = await importFixture(ctx, "attention-budget.pdf");
});
afterEach(() => cleanup());

describe("provenance", () => {
  it("a Quote is the page's exact text even when the selection arrives with different whitespace", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote",
      docId,
      page: 2,
      selectionText: "attention   is a\nscarce  resource.",
    });
    expect(unit.content).toBe(SCARCE);
    const pageText = getPageText(ctx, docId, 2)!;
    expect(pageText.slice(unit.start, unit.end)).toBe(unit.content);
    expect(unit.sourceText).toBe(unit.content);
    expect(unit.passageId).not.toBeNull();
    expect(unit.highlightId).not.toBeNull();
    expect(listHighlights(ctx, docId).length).toBe(1);
  });

  it("ignores any client-supplied content for a quote", async () => {
    const { unit } = await createUnit(ctx, {
      type: "quote",
      content: "Made up words the author never wrote",
      docId,
      page: 2,
      selectionText: SCARCE,
    });
    expect(unit.content).toBe(SCARCE);
  });

  it("rejects a selection that is not on the page, and a nonexistent page", async () => {
    await expect(
      createUnit(ctx, { type: "quote", docId, page: 2, selectionText: "words that are not in the document" }),
    ).rejects.toThrow(/Could not match/);
    await expect(createUnit(ctx, { type: "quote", docId, page: 99, selectionText: SCARCE })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("an idea needs the user's own words and keeps a link to the exact source passage", async () => {
    await expect(createUnit(ctx, { type: "idea", docId, page: 2, selectionText: SCARCE })).rejects.toThrow(
      /own words/,
    );
    const { unit } = await createUnit(ctx, {
      type: "idea",
      content: "Focus should be budgeted like money.",
      docId,
      page: 2,
      selectionText: SCARCE,
    });
    expect(unit.content).toBe("Focus should be budgeted like money.");
    expect(unit.sourceText).toBe(SCARCE);
    expect(unit.docTitle).toBe("The Attention Budget");
    expect(unit.page).toBe(2);
  });

  it("quotes cannot be edited, but notes can; ideas can be edited and are flagged as edited", async () => {
    const q = (await createUnit(ctx, { type: "quote", docId, page: 2, selectionText: SCARCE })).unit;
    await expect(updateUnit(ctx, q.id, { content: "altered" })).rejects.toThrow(/exact wording/);
    expect((await updateUnit(ctx, q.id, { note: "check later" })).note).toBe("check later");

    const i = (
      await createUnit(ctx, { type: "idea", content: "first zanzibar wording", docId, page: 2, selectionText: SCARCE })
    ).unit;
    expect(i.edited).toBe(false);
    const edited = await updateUnit(ctx, i.id, { content: "second wording about budgets" });
    expect(edited.edited).toBe(true);
    const r = await search(ctx, "budgets");
    expect(r.saved.units.map((u) => u.unit.id)).toContain(i.id);
    // the old wording is gone from the index
    expect((await search(ctx, "zanzibar")).saved.units.length).toBe(0);
  });

  it("highlights are idempotent per span", async () => {
    const a = createHighlight(ctx, { docId, page: 2, selectionText: SCARCE });
    const b = createHighlight(ctx, { docId, page: 2, selectionText: SCARCE, note: "n" });
    expect(b.id).toBe(a.id);
    expect(b.note).toBe("n");
  });
});

describe("accepted knowledge is searchable and grouped", () => {
  it("units appear in search with counts by type, ahead of passages in the response", async () => {
    await createUnit(ctx, { type: "quote", docId, page: 2, selectionText: SCARCE });
    await createUnit(ctx, {
      type: "idea",
      content: "Treat attention as a budget",
      docId,
      page: 2,
      selectionText: SCARCE,
    });
    await createUnit(ctx, {
      type: "question",
      content: "What is the cheapest interruption policy?",
      docId,
      page: 3,
      selectionText: "Batching communication into fixed windows is the simplest policy that works.",
    });
    const r = await search(ctx, "attention");
    expect(r.saved.counts.quote).toBe(1);
    expect(r.saved.counts.idea).toBe(1);
    expect(r.passages.length).toBeGreaterThan(0);

    const onlyIdeas = await search(ctx, "type:idea");
    expect(onlyIdeas.saved.units.length).toBe(1);
    expect(onlyIdeas.passages.length).toBe(0);

    const withNote = await createUnit(ctx, {
      type: "idea",
      content: "Block deep work",
      note: "revisit this next quarter",
      docId,
      page: 2,
      selectionText: "A team that protects deep work hours is making an allocation decision",
    });
    const byNote = await search(ctx, "note:revisit");
    expect(byNote.saved.units.map((u) => u.unit.id)).toEqual([withNote.unit.id]);
  });

  it("deleting a unit removes it from search", async () => {
    const { unit } = await createUnit(ctx, {
      type: "idea",
      content: "ephemeral zebra idea",
      docId,
      page: 2,
      selectionText: SCARCE,
    });
    expect((await search(ctx, "zebra")).saved.units.length).toBe(1);
    deleteUnit(ctx, unit.id);
    expect((await search(ctx, "zebra")).saved.units.length).toBe(0);
  });
});

describe("relations and same-idea suggestion", () => {
  it("offers a same-idea suggestion at save time for similar ideas, but never for quotes", async () => {
    const a = (
      await createUnit(ctx, {
        type: "idea",
        content: "attention is a scarce resource that every notification spends",
        docId,
        page: 2,
        selectionText: SCARCE,
      })
    ).unit;
    const second = await createUnit(ctx, {
      type: "idea",
      content: "every notification spends a scarce resource: attention",
      docId,
      page: 2,
      selectionText: "Treating focus as a budget changes the question",
    });
    expect(second.suggestion?.unit.id).toBe(a.id);
    expect(second.suggestion!.similarity).toBeGreaterThan(0.6);

    const quote = await createUnit(ctx, {
      type: "quote",
      docId,
      page: 2,
      selectionText: "Treating focus as a budget changes the question",
    });
    expect(quote.suggestion).toBeNull();
  });

  it("links are user-made, same_idea is symmetric, self-links are rejected, and context shows both directions", async () => {
    const mk = async (c: string) =>
      (await createUnit(ctx, { type: "idea", content: c, docId, page: 2, selectionText: SCARCE })).unit;
    const a = await mk("alpha idea");
    const b = await mk("beta idea");
    const l1 = createLink(ctx, b.id, a.id, "same_idea");
    const l2 = createLink(ctx, a.id, b.id, "same_idea");
    expect(l2).toBe(l1);
    expect(() => createLink(ctx, a.id, a.id, "supports")).toThrow(/itself/);
    createLink(ctx, a.id, b.id, "supports");

    const ctxA = getUnitContext(ctx, a.id);
    expect(ctxA.links.length).toBe(2);
    const ctxB = getUnitContext(ctx, b.id);
    expect(ctxB.links.some((l) => l.relation === "supports" && l.direction === "in")).toBe(true);
    expect(ctxA.paragraph).toContain(SCARCE);
  });
});

describe("Distill", () => {
  const provider = (raw: unknown[]): DistillProvider => ({ distill: async () => raw as never });

  it("verifyCandidates drops candidates whose supporting quote is not verbatim in the source paragraph", () => {
    const para =
      "Attention is a scarce resource. Every notification, meeting, and open tab draws on the same limited supply.";
    const { candidates, dropped } = verifyCandidates(
      [
        { type: "idea", text: "Attention is limited", supportingQuote: "Attention is a scarce resource." },
        { type: "idea", text: "Invented claim", supportingQuote: "Attention is infinite and free" },
        { type: "concept", text: "Shared supply", supportingQuote: "draws   on the SAME limited supply" },
        { type: "quote", text: "wrong type", supportingQuote: "Attention is a scarce resource." },
        { type: "idea", text: "Too short quote", supportingQuote: "scarce" },
        { type: "idea", text: "attention is limited", supportingQuote: "Attention is a scarce resource." },
        { type: "idea", text: "", supportingQuote: "Attention is a scarce resource." },
      ],
      para,
    );
    expect(candidates.map((c) => c.text)).toEqual(["Attention is limited", "Shared supply"]);
    expect(candidates[1].supportingQuote).toBe("draws on the same limited supply"); // source wording, not the model's
    expect(dropped).toBe(5);
  });

  it("caps at three candidates", () => {
    const para = "The quick brown fox jumps over the lazy dog near the river bank today.";
    const raw = Array.from({ length: 6 }, (_, i) => ({
      type: "idea",
      text: `candidate ${i}`,
      supportingQuote: "quick brown fox jumps",
    }));
    expect(verifyCandidates(raw, para).candidates.length).toBe(3);
  });

  it("returns verified candidates and the exact anchor without writing anything to the library", async () => {
    const res = await distillSelection(
      ctx,
      provider([
        { type: "idea", text: "Focus is a budget", supportingQuote: "Treating focus as a budget" },
        { type: "idea", text: "hallucinated", supportingQuote: "This sentence is not in the book at all" },
      ]),
      { docId, page: 2, selectionText: "Treating focus as a budget changes the question" },
    );
    expect(res.candidates.length).toBe(1);
    expect(res.dropped).toBe(1);
    expect(res.anchor.text).toBe("Treating focus as a budget changes the question");
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM units").get() as { c: number }).c).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM candidate_events").get() as { c: number }).c).toBe(0);
  });

  it("explains clearly when no AI provider is configured and surfaces provider failures", async () => {
    await expect(distillSelection(ctx, null, { docId, page: 2, selectionText: SCARCE })).rejects.toThrow(
      /No AI provider/,
    );
    const failing: DistillProvider = { distill: async () => Promise.reject(new Error("boom")) };
    await expect(distillSelection(ctx, failing, { docId, page: 2, selectionText: SCARCE })).rejects.toThrow(
      /AI provider failed: boom/,
    );
  });

  it("counts accept, edit and dismiss quietly through the API, and shows no trace in search", async () => {
    const app = await buildApp(ctx, {
      provider: provider([{ type: "idea", text: "Focus is a budget", supportingQuote: "Treating focus as a budget" }]),
    });
    const d = await app.inject({
      method: "POST",
      url: "/api/distill",
      payload: { docId, page: 2, selectionText: "Treating focus as a budget changes the question" },
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().candidates.length).toBe(1);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/units",
      payload: {
        type: "idea",
        content: "Focus is a budget",
        docId,
        page: 2,
        selectionText: "Treating focus as a budget changes the question",
        origin: "distill",
        candidateAction: "accept",
      },
    });
    expect(accepted.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/units",
      payload: {
        type: "concept",
        content: "Allocation, not lifestyle",
        docId,
        page: 2,
        selectionText: "making an allocation decision",
        origin: "distill",
        candidateAction: "edit",
      },
    });
    await app.inject({ method: "POST", url: "/api/candidate-events", payload: { unitType: "question", docId } });

    const events = ctx.db.prepare("SELECT action, unit_type FROM candidate_events ORDER BY id").all();
    expect(events).toEqual([
      { action: "accept", unit_type: "idea" },
      { action: "edit", unit_type: "concept" },
      { action: "dismiss", unit_type: "question" },
    ]);
    // dismissed candidate left nothing behind in the library
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM units WHERE type='question'").get() as { c: number }).c).toBe(0);
    await app.close();
  });

  it("returns a helpful 400 from the API when Distill is not configured", async () => {
    const app = await buildApp(ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/distill",
      payload: { docId, page: 2, selectionText: SCARCE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Settings/);
    await app.close();
  });
});

describe("re-anchoring after re-extraction", () => {
  it("restores shifted highlights and units from prefix/suffix, and marks vanished text stale", async () => {
    const h = createHighlight(ctx, { docId, page: 2, selectionText: SCARCE });
    const { unit } = await createUnit(ctx, { type: "quote", docId, page: 2, selectionText: SCARCE });
    const vanished = createHighlight(ctx, { docId, page: 3, selectionText: "Batching similar tasks together" });

    // simulate drift: stored offsets are wrong, and one highlight's text no longer exists
    ctx.db.prepare("UPDATE highlights SET start=start+7, end=end+7 WHERE id=?").run(h.id);
    ctx.db.prepare("UPDATE units SET start=start+7, end=end+7 WHERE id=?").run(unit.id);
    ctx.db.prepare("UPDATE highlights SET text='text that no longer exists anywhere' WHERE id=?").run(vanished.id);

    await reprocessDocument(ctx, docId);

    const hs = listHighlights(ctx, docId);
    const fixed = hs.find((x) => x.id === h.id)!;
    expect(getPageText(ctx, docId, 2)!.slice(fixed.start, fixed.end)).toBe(SCARCE);
    expect(fixed.stale).toBe(false);
    expect(hs.find((x) => x.id === vanished.id)!.stale).toBe(true);

    const u = ctx.db.prepare("SELECT start, end, passage_id FROM units WHERE id=?").get(unit.id) as {
      start: number;
      end: number;
      passage_id: number | null;
    };
    expect(getPageText(ctx, docId, 2)!.slice(u.start, u.end)).toBe(SCARCE);
    expect(u.passage_id).not.toBeNull();
  });
});

describe("export and backup (model independent)", () => {
  it("exports units with full provenance and no derived embeddings", async () => {
    const a = (await createUnit(ctx, { type: "quote", docId, page: 2, selectionText: SCARCE })).unit;
    const b = (
      await createUnit(ctx, {
        type: "idea",
        content: "Budget your focus",
        note: "applies to my team",
        docId,
        page: 2,
        selectionText: SCARCE,
      })
    ).unit;
    createLink(ctx, b.id, a.id, "supports");

    const bundle = buildExport(ctx);
    expect(bundle.documents[0].title).toBe("The Attention Budget");
    expect(bundle.units.length).toBe(2);
    const idea = bundle.units.find((u) => u.type === "idea")!;
    expect(idea.source).toMatchObject({ documentTitle: "The Attention Budget", page: 2, text: SCARCE });
    expect(idea.source.documentHash).toBe(bundle.documents[0].hash);
    expect(bundle.links).toEqual([{ fromUnit: b.id, toUnit: a.id, relation: "supports" }]);
    expect(JSON.stringify(bundle)).not.toMatch(/embedding|"vec"/);

    const md = buildMarkdown(ctx);
    expect(md).toContain("## The Attention Budget");
    expect(md).toContain("**Idea**: Budget your focus");
    expect(md).toContain("Source: The Attention Budget, p. 2");
    expect(md).toContain("## Connections");
  });

  it("backs up while running and restores into a new library with everything intact", async () => {
    await createUnit(ctx, { type: "quote", docId, page: 2, selectionText: SCARCE });
    writeAiSettings(ctx.cfg, { baseUrl: "http://x/v1", model: "m", apiKey: "SECRET-KEY" });

    const base = mkdtempSync(join(tmpdir(), "sr-backup-"));
    const dest = join(base, "bk");
    const target = join(base, "restored");
    try {
      const { manifest } = await createBackup(ctx, dest);
      expect(manifest.documents).toBe(1);
      expect(readFileSync(join(dest, "settings.json"), "utf8")).not.toContain("SECRET-KEY");
      await expect(createBackup(ctx, dest)).rejects.toThrow(/already exists/);

      restoreBackup(dest, target);
      expect(() => restoreBackup(dest, target)).toThrow(/already contains/);
      restoreBackup(dest, target, { force: true });

      const restored = createContext(loadConfig({ libraryDir: target, embeddings: "off" }), { embedder: null });
      const units = restored.db.prepare("SELECT content FROM units").all() as { content: string }[];
      expect(units.map((u) => u.content)).toEqual([SCARCE]);
      expect(existsSync(join(target, "originals"))).toBe(true);
      expect((await search(restored, "scarce")).saved.units.length).toBe(1); // FTS survived the round trip
      restored.db.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects restoring from a folder that is not a backup", () => {
    expect(() => restoreBackup(tmpdir(), join(tmpdir(), "nowhere-xyz"))).toThrow(/not a backup/);
  });
});
