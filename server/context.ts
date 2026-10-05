import type { DB } from "./db.ts";
import { openDb } from "./db.ts";
import type { Config } from "./config.ts";
import { EmbedJob, TransformersEmbedder, VectorIndex, type Embedder } from "./search/embeddings.ts";

export interface Ctx {
  cfg: Config;
  db: DB;
  embedder: Embedder | null;
  vectors: { passage: VectorIndex; unit: VectorIndex };
  embedJob: EmbedJob;
  /** in-flight background document processing, so tests and shutdown can await it */
  inflight: Set<Promise<unknown>>;
}

export function createContext(cfg: Config, opts: { embedder?: Embedder | null } = {}): Ctx {
  const db = openDb(cfg.dbFile);
  const embedder: Embedder | null =
    opts.embedder !== undefined
      ? opts.embedder
      : cfg.embeddings === "on"
        ? new TransformersEmbedder(cfg.embeddingModel, cfg.modelsDir)
        : null;
  const vectors = {
    passage: new VectorIndex(db, "passage", cfg.embeddingModel),
    unit: new VectorIndex(db, "unit", cfg.embeddingModel),
  };
  const embedJob = new EmbedJob(db, cfg, embedder, vectors);
  return { cfg, db, embedder, vectors, embedJob, inflight: new Set() };
}

export async function idle(ctx: Ctx): Promise<void> {
  while (ctx.inflight.size) await Promise.allSettled([...ctx.inflight]);
  await ctx.embedJob.kick();
}
