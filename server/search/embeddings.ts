import type { DB } from "../db.ts";
import type { Config } from "../config.ts";
import { forIndex } from "../text/dehyphen.ts";

// Embeddings are DERIVED data: they can be thrown away and rebuilt when the model changes.
// The user's real assets are sources, units, links and provenance.

export interface Embedder {
  name: string;
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export class TransformersEmbedder implements Embedder {
  private extractor: Promise<any> | null = null;
  constructor(
    public name: string,
    private cacheDir: string,
  ) {}

  private load() {
    if (!this.extractor) {
      this.extractor = (async () => {
        const tf = await import("@huggingface/transformers");
        tf.env.cacheDir = this.cacheDir;
        return tf.pipeline("feature-extraction", this.name, { dtype: "q8" });
      })();
      // allow a later retry (e.g. after going online) if loading failed
      this.extractor.catch(() => {
        this.extractor = null;
      });
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const ex = await this.load();
    const out = await ex(texts, { pooling: "mean", normalize: true });
    const dim = out.dims[1] as number;
    const data = out.data as Float32Array;
    return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  }
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function fromBlob(b: Buffer): Float32Array {
  const copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(copy);
}

export interface VectorHit {
  id: number;
  score: number;
}

/** Brute-force cosine search over normalized vectors held in memory. Fine at personal scale. */
export class VectorIndex {
  private loaded = false;
  private ids: number[] = [];
  private data = new Float32Array(0);
  private dim = 0;
  private count = 0;

  constructor(
    private db: DB,
    private kind: "passage" | "unit",
    private model: string,
  ) {}

  invalidate() {
    this.loaded = false;
  }

  private ensureLoaded() {
    if (this.loaded) return;
    const rows = this.db
      .prepare("SELECT ref_id, dim, vec FROM embeddings WHERE kind = ? AND model = ?")
      .all(this.kind, this.model) as { ref_id: number; dim: number; vec: Buffer }[];
    this.ids = [];
    this.count = 0;
    this.dim = rows[0]?.dim ?? 0;
    this.data = new Float32Array(rows.length * this.dim);
    for (const r of rows) {
      this.data.set(fromBlob(r.vec), this.count * this.dim);
      this.ids.push(r.ref_id);
      this.count++;
    }
    this.loaded = true;
  }

  add(id: number, vec: Float32Array) {
    this.ensureLoaded();
    if (this.dim === 0) this.dim = vec.length;
    if (this.count * this.dim + this.dim > this.data.length) {
      const bigger = new Float32Array(Math.max(1024 * this.dim, this.data.length * 2));
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data.set(vec, this.count * this.dim);
    this.ids.push(id);
    this.count++;
  }

  size(): number {
    this.ensureLoaded();
    return this.count;
  }

  search(q: Float32Array, k: number, allow?: (id: number) => boolean): VectorHit[] {
    this.ensureLoaded();
    if (this.count === 0 || q.length !== this.dim) return [];
    const hits: VectorHit[] = [];
    for (let i = 0; i < this.count; i++) {
      const id = this.ids[i];
      if (allow && !allow(id)) continue;
      let dot = 0;
      const off = i * this.dim;
      for (let j = 0; j < this.dim; j++) dot += this.data[off + j] * q[j];
      hits.push({ id, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** Cosine similarity of one stored vector against others (used for "same idea" suggestions). */
  nearest(q: Float32Array, k: number, exclude: number): VectorHit[] {
    return this.search(q, k + 1, (id) => id !== exclude).slice(0, k);
  }
}

export type EmbedState = "off" | "idle" | "working" | "unavailable";

/** Background job that fills in missing embeddings for the configured model. */
export class EmbedJob {
  state: EmbedState;
  error: string | undefined;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private db: DB,
    private cfg: Config,
    private embedder: Embedder | null,
    private index: { passage: VectorIndex; unit: VectorIndex },
  ) {
    this.state = embedder ? "idle" : "off";
  }

  pendingCount(): number {
    if (!this.embedder) return 0;
    const m = this.cfg.embeddingModel;
    const p = this.db
      .prepare(
        `SELECT COUNT(*) c FROM passages p WHERE NOT EXISTS
         (SELECT 1 FROM embeddings e WHERE e.kind='passage' AND e.ref_id=p.id AND e.model=?)`,
      )
      .get(m) as { c: number };
    const u = this.db
      .prepare(
        `SELECT COUNT(*) c FROM units u WHERE NOT EXISTS
         (SELECT 1 FROM embeddings e WHERE e.kind='unit' AND e.ref_id=u.id AND e.model=?)`,
      )
      .get(m) as { c: number };
    return p.c + u.c;
  }

  pendingDocIds(): Set<number> {
    if (!this.embedder) return new Set();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.doc_id d FROM passages p WHERE NOT EXISTS
         (SELECT 1 FROM embeddings e WHERE e.kind='passage' AND e.ref_id=p.id AND e.model=?)`,
      )
      .all(this.cfg.embeddingModel) as { d: number }[];
    return new Set(rows.map((r) => r.d));
  }

  /** Start (or continue) filling in missing embeddings. Resolves when the queue is drained. */
  kick(): Promise<void> {
    if (!this.embedder) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.kick();
      }
    });
    return this.running;
  }

  private async run() {
    const embedder = this.embedder!;
    const model = this.cfg.embeddingModel;
    this.state = "working";
    this.error = undefined;
    try {
      for (const kind of ["passage", "unit"] as const) {
        // Passages are embedded from the keyword index text (line-end hyphens already resolved).
        const from = kind === "passage" ? "passages t JOIN passages_fts f ON f.rowid = t.id" : "units t";
        const textCol = kind === "passage" ? "f.body" : "t.content";
        const select = this.db.prepare(
          `SELECT t.id id, ${textCol} text FROM ${from} WHERE NOT EXISTS
           (SELECT 1 FROM embeddings e WHERE e.kind='${kind}' AND e.ref_id=t.id AND e.model=?) LIMIT 16`,
        );
        const insert = this.db.prepare(
          "INSERT OR REPLACE INTO embeddings(kind, ref_id, model, dim, vec) VALUES (?,?,?,?,?)",
        );
        for (;;) {
          const rows = select.all(model) as { id: number; text: string }[];
          if (rows.length === 0) break;
          const vecs = await embedder.embed(
            rows.map((r) => (kind === "unit" ? forIndex(r.text) : r.text)),
            "passage",
          );
          const tx = this.db.transaction(() => {
            rows.forEach((r, i) => insert.run(kind, r.id, model, vecs[i].length, toBlob(vecs[i])));
          });
          tx();
          rows.forEach((r, i) => this.index[kind].add(r.id, vecs[i]));
        }
      }
      this.state = "idle";
    } catch (e) {
      this.state = "unavailable";
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Throw away all derived vectors and rebuild them with the configured model. */
  async rebuild(): Promise<void> {
    this.db.prepare("DELETE FROM embeddings").run();
    this.index.passage.invalidate();
    this.index.unit.invalidate();
    await this.kick();
  }
}
