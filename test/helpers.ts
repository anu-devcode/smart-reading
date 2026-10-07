import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config.ts";
import { createContext, idle, type Ctx } from "../server/context.ts";
import { importFile } from "../server/ingest/pipeline.ts";
import { makeFixtures } from "../eval/make-fixtures.ts";
import type { Embedder } from "../server/search/embeddings.ts";
import type { OcrEngine } from "../server/ingest/ocr.ts";

export function tempCtx(opts: { embedder?: Embedder | null; ocr?: OcrEngine | null } = {}): { ctx: Ctx; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "smart-reading-"));
  const cfg = loadConfig({
    libraryDir: dir,
    embeddings: "off",
    ...(opts.embedder ? { embeddingModel: opts.embedder.name } : {}),
  });
  const ctx = createContext(cfg, { embedder: opts.embedder ?? null, ocr: opts.ocr ?? null });
  return {
    ctx,
    cleanup: () => {
      try {
        ctx.db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// One private fixture folder per test process, written once. (A shared folder rewritten by every call
// raced between parallel test files and made PDFs unreadable mid-write.)
let fixtureDir: string | null = null;
function privateFixtures(): string {
  if (!fixtureDir) fixtureDir = makeFixtures(mkdtempSync(join(tmpdir(), "smart-reading-fixtures-")));
  return fixtureDir;
}

export async function importFixture(ctx: Ctx, file: string) {
  const dir = privateFixtures();
  const res = importFile(ctx, { name: file, data: readFileSync(join(dir, file)) });
  await res.done;
  await idle(ctx);
  return res.document.id;
}

/**
 * Deterministic bag-of-words embedder for tests: hashes words into a small vector, so texts that share
 * words are similar. Lets us test plumbing (storage, merge, thresholds) without downloading a model.
 */
export class FakeEmbedder implements Embedder {
  name = "fake-bow";
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 2166136261;
        for (const ch of w.replace(/(ing|ed|es|s)$/, "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
        v[Math.abs(h) % 64] += 1;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  }
}
