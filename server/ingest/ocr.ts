import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { Ctx } from "../context.ts";
import type { OcrWordDto } from "../../shared/types.ts";
import { readOcrSettings } from "../config.ts";
import { classifyPageText } from "./extract.ts";
import { applyOcrPage, refreshDocumentStatus } from "./pipeline.ts";

/**
 * Reading scanned pages (OCR).
 *
 * Text extraction comes first and stays the source of truth: only pages with no text of their own are
 * sent here. What comes back is checked before it is trusted. A page the engine could not read reliably is
 * recorded as such, with the reason, and stays unreadable instead of being filled with guesses.
 */

// ---------- engine ----------

export interface RawWord {
  text: string;
  /** 0..100 */
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Blocks in the engine's reading order (the engine separates columns itself), each a list of lines of words. */
export interface RawPage {
  width: number;
  height: number;
  blocks: { lines: RawWord[][] }[];
}

export interface OcrEngine {
  recognize(png: Buffer, size: { width: number; height: number }, language: string): Promise<RawPage>;
  close(): Promise<void>;
}

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessBlock {
  paragraphs?: { lines?: { words?: TessWord[] }[] }[];
}

/** Tesseract (WebAssembly). The language data is fetched on first use and kept in the library's models folder. */
export class TesseractEngine implements OcrEngine {
  private worker: import("tesseract.js").Worker | null = null;
  private lang = "";
  private cacheDir: string;

  constructor(modelsDir: string) {
    this.cacheDir = join(modelsDir, "tesseract");
  }

  async recognize(png: Buffer, size: { width: number; height: number }, language: string): Promise<RawPage> {
    if (!this.worker || this.lang !== language) {
      await this.close();
      mkdirSync(this.cacheDir, { recursive: true });
      const { createWorker } = await import("tesseract.js");
      this.worker = await createWorker(language, 1, { cachePath: this.cacheDir, logger: () => undefined });
      this.lang = language;
    }
    const res = await this.worker.recognize(png, {}, { blocks: true });
    const blocks = ((res.data as unknown as { blocks?: TessBlock[] | null }).blocks ?? []).map((b) => ({
      lines: (b.paragraphs ?? []).flatMap((p) =>
        (p.lines ?? []).map((l) =>
          (l.words ?? []).map((w) => ({
            text: w.text,
            confidence: w.confidence,
            x0: w.bbox.x0,
            y0: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
          })),
        ),
      ),
    }));
    return { width: size.width, height: size.height, blocks };
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.lang = "";
    if (w) await w.terminate().catch(() => undefined);
  }
}

// ---------- turning engine output into a page ----------

/** Words the engine itself is very unsure about are left out of the text. */
const MIN_WORD_CONFIDENCE = 30;
/** A page whose words are on average less certain than this is rejected, not trusted. */
export const MIN_PAGE_CONFIDENCE = 60;
/** A gap between lines larger than this many normal line pitches starts a new paragraph. */
const PARAGRAPH_GAP = 1.7;

export interface OcrPageResult {
  status: "ok" | "rejected";
  reason: string | null;
  text: string;
  words: OcrWordDto[];
  /** mean word confidence, 0..100 */
  confidence: number;
}

const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function buildOcrPage(raw: RawPage): OcrPageResult {
  // mean confidence over every word that has letters or digits, weighted by length
  let confSum = 0;
  let confWeight = 0;
  for (const b of raw.blocks) {
    for (const l of b.lines) {
      for (const w of l) {
        if (!hasContent(w.text)) continue;
        const n = w.text.trim().length;
        confSum += w.confidence * n;
        confWeight += n;
      }
    }
  }
  const confidence = confWeight ? confSum / confWeight : 0;

  type Line = { words: RawWord[]; top: number };
  const blocks: Line[][] = raw.blocks
    .map((b) =>
      b.lines
        .map((l) => l.filter((w) => w.text.trim() && hasContent(w.text) && w.confidence >= MIN_WORD_CONFIDENCE))
        .filter((l) => l.length)
        .map((l) => ({ words: l, top: Math.min(...l.map((w) => w.y0)) })),
    )
    .filter((b) => b.length);

  const pitches: number[] = [];
  for (const b of blocks) for (let i = 1; i < b.length; i++) pitches.push(b[i].top - b[i - 1].top);
  const pitch = median(pitches.filter((p) => p > 0));

  let text = "";
  const words: OcrWordDto[] = [];
  const r4 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000;
  blocks.forEach((b) => {
    b.forEach((line, li) => {
      if (text) {
        const gap = li > 0 ? line.top - b[li - 1].top : Infinity;
        text += li === 0 || (pitch > 0 && gap > pitch * PARAGRAPH_GAP) ? "\n\n" : "\n";
      }
      line.words.forEach((w, wi) => {
        if (wi > 0) text += " ";
        const s = text.length;
        text += w.text.trim();
        words.push({
          s,
          e: text.length,
          x0: r4(w.x0 / raw.width),
          y0: r4(w.y0 / raw.height),
          x1: r4(w.x1 / raw.width),
          y1: r4(w.y1 / raw.height),
        });
      });
    });
  });

  if (classifyPageText(text) === "empty") {
    return { status: "rejected", reason: "no readable text was found", text: "", words: [], confidence };
  }
  if (confidence < MIN_PAGE_CONFIDENCE) {
    return { status: "rejected", reason: "the recognised text was too uncertain to trust", text: "", words: [], confidence };
  }
  return { status: "ok", reason: null, text, words, confidence };
}

// ---------- rendering a PDF page to an image ----------

/** About 220 dpi: enough for ordinary print, while keeping a page to a few seconds. */
const OCR_DPI = 220;
const MAX_SIDE_PX = 4000;

interface RenderablePdf {
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: unknown): { promise: Promise<void> };
    cleanup(): void;
  }>;
}

export async function renderPagePng(pdf: RenderablePdf, pageNo: number): Promise<{ png: Buffer; width: number; height: number }> {
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, MAX_SIDE_PX / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  page.cleanup();
  return { png: canvas.toBuffer("image/png"), width, height };
}

// ---------- the background job ----------

export type OcrState = "off" | "idle" | "working" | "unavailable";

export class OcrJob {
  state: OcrState;
  error: string | undefined;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private getCtx: () => Ctx,
    private engine: OcrEngine | null,
  ) {
    this.state = engine ? "idle" : "off";
  }

  private get ctx() {
    return this.getCtx();
  }

  /** OCR is installed and switched on (whether or not it has run into trouble). */
  enabled(): boolean {
    return !!this.engine && readOcrSettings(this.ctx.cfg).enabled;
  }

  private active(): boolean {
    return !!this.engine && !this.error && readOcrSettings(this.ctx.cfg).enabled;
  }

  /** Pages that have no text of their own and have not been tried with the current language yet. */
  private pendingRows(): { doc_id: number; page: number }[] {
    return this.ctx.db
      .prepare(
        `SELECT p.doc_id, p.page FROM pages p JOIN documents d ON d.id = p.doc_id
         WHERE d.kind = 'pdf' AND p.status = 'empty'
           AND NOT EXISTS (SELECT 1 FROM ocr_pages o WHERE o.doc_id = p.doc_id AND o.page = p.page AND o.lang = ?)
         ORDER BY p.doc_id, p.page`,
      )
      .all(readOcrSettings(this.ctx.cfg).language) as { doc_id: number; page: number }[];
  }

  pendingByDoc(): Map<number, number> {
    const m = new Map<number, number>();
    if (!this.active()) return m;
    for (const r of this.pendingRows()) m.set(r.doc_id, (m.get(r.doc_id) ?? 0) + 1);
    return m;
  }

  pendingCount(): number {
    let n = 0;
    for (const c of this.pendingByDoc().values()) n += c;
    return n;
  }

  /** Forget a previous failure (e.g. the user changed a setting) and pick up any waiting pages. */
  retry(): Promise<void> {
    this.error = undefined;
    return this.kick();
  }

  kick(): Promise<void> {
    if (!this.engine) return Promise.resolve();
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
    const engine = this.engine!;
    const { cfg, db } = this.ctx;
    this.state = this.active() ? "working" : this.error ? "unavailable" : "off";
    try {
      while (this.active()) {
        const rows = this.pendingRows();
        if (!rows.length) break;
        const docId = rows[0].doc_id;
        const pages = rows.filter((r) => r.doc_id === docId).map((r) => r.page);
        const stored = db.prepare("SELECT stored_name FROM documents WHERE id = ?").get(docId) as { stored_name: string } | undefined;
        const file = stored ? join(cfg.originalsDir, stored.stored_name) : "";
        const language = readOcrSettings(cfg).language;

        type OpenPdf = RenderablePdf & { destroy(): Promise<void> };
        let pdf = null as OpenPdf | null;
        if (file && existsSync(file)) {
          try {
            const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
            pdf = (await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise) as never;
          } catch {
            pdf = null;
          }
        }
        const save = db.prepare(
          `INSERT OR REPLACE INTO ocr_pages(doc_id, page, status, reason, text, words, confidence, lang) VALUES (?,?,?,?,?,?,?,?)`,
        );
        try {
          for (const page of pages) {
            if (!this.active()) break;
            let result: OcrPageResult;
            let img: { png: Buffer; width: number; height: number } | null = null;
            if (pdf) {
              try {
                img = await renderPagePng(pdf, page);
              } catch {
                img = null;
              }
            }
            if (!img) {
              result = { status: "rejected", reason: "the page could not be drawn for reading", text: "", words: [], confidence: 0 };
            } else {
              // An engine failure (e.g. language data cannot be fetched) stops the job; it is not the page's fault.
              const raw = await engine.recognize(img.png, { width: img.width, height: img.height }, language);
              result = buildOcrPage(raw);
            }
            save.run(docId, page, result.status, result.reason, result.text, JSON.stringify(result.words), result.confidence, language);
            applyOcrPage(this.ctx, docId, page);
          }
        } finally {
          await pdf?.destroy().catch(() => undefined);
        }
      }
      this.state = this.error ? "unavailable" : this.active() ? "idle" : "off";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.state = "unavailable";
      await engine.close().catch(() => undefined);
    }
    // If nothing more will be read (switched off, or the engine failed), notes must not still say "waiting".
    if (!this.active()) {
      for (const docId of new Set(this.pendingRows().map((r) => r.doc_id))) refreshDocumentStatus(this.ctx, docId);
    }
  }

  async close() {
    await this.running?.catch(() => undefined);
    await this.engine?.close();
  }
}
