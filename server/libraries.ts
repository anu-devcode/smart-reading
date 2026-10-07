import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { libraryConfig, type Config } from "./config.ts";
import { createContext, type Ctx } from "./context.ts";
import { TesseractEngine, type OcrEngine } from "./ingest/ocr.ts";
import { TransformersEmbedder, type Embedder } from "./search/embeddings.ts";

/**
 * One library per account, each in its own folder with its own database. Nothing in one library can
 * reference another, so a person can only ever see their own documents and knowledge.
 * The meaning-search model and the OCR engine are loaded once and shared.
 */
export class Libraries {
  private open = new Map<number, Ctx>();
  readonly embedder: Embedder | null;
  private ocr: SharedOcr | null;

  constructor(
    readonly base: Config,
    shared: { embedder?: Embedder | null; ocr?: OcrEngine | null } = {},
  ) {
    this.embedder =
      shared.embedder !== undefined
        ? shared.embedder
        : base.embeddings === "on"
          ? new TransformersEmbedder(base.embeddingModel, base.modelsDir)
          : null;
    const engine = shared.ocr !== undefined ? shared.ocr : base.ocr === "on" ? new TesseractEngine(base.modelsDir) : null;
    this.ocr = engine ? new SharedOcr(engine) : null;
  }

  dirOf(userId: number): string {
    return join(this.base.libraryDir, "users", String(userId));
  }

  forUser(userId: number): Ctx {
    let ctx = this.open.get(userId);
    if (!ctx) {
      ctx = createContext(libraryConfig(this.base, this.dirOf(userId)), { embedder: this.embedder, ocr: this.ocr?.view() ?? null });
      this.open.set(userId, ctx);
      void ctx.ocrJob.kick();
      void ctx.embedJob.kick();
    }
    return ctx;
  }

  /**
   * A library from before accounts existed sits directly in the library folder. It becomes the first
   * account's library, unchanged. Returns true if one was moved.
   */
  adoptLegacy(userId: number): boolean {
    const root = this.base.libraryDir;
    if (!existsSync(join(root, "library.db"))) return false;
    const dest = this.dirOf(userId);
    if (existsSync(join(dest, "library.db"))) return false;
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(root)) {
      if (f === "library.db" || f.startsWith("library.db-") || f === "settings.json" || f === "originals" || f === "exports") {
        if (f === "originals" && existsSync(join(dest, "originals"))) rmSync(join(dest, "originals"), { recursive: true, force: true });
        renameSync(join(root, f), join(dest, f));
      }
    }
    return true;
  }

  async close(userId: number): Promise<void> {
    const ctx = this.open.get(userId);
    if (!ctx) return;
    this.open.delete(userId);
    await Promise.allSettled([...ctx.inflight]);
    await ctx.ocrJob.close();
    ctx.db.close();
  }

  /** Delete an account's library for good. */
  async remove(userId: number): Promise<void> {
    await this.close(userId);
    rmSync(this.dirOf(userId), { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.open.keys()]) await this.close(id);
    await this.ocr?.close();
  }
}

/**
 * One OCR worker serves every library, one page at a time. (It restarts when the language changes, so
 * two libraries reading in different languages at once would otherwise cut each other off mid-page.)
 */
export class SharedOcr {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private engine: OcrEngine) {}

  view(): OcrEngine {
    return {
      recognize: (png, size, language) => this.queue(() => this.engine.recognize(png, size, language)),
      close: async () => undefined, // a library closing must not stop the worker the others use
    };
  }

  private queue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => undefined);
    return p;
  }

  close(): Promise<void> {
    return this.engine.close();
  }
}
