import type { DocKind } from "../../shared/types.ts";
import { itemsToPageText, type PdfItem } from "./layout.ts";

export interface ExtractedPage {
  page: number;
  text: string;
  status: "ok" | "empty" | "garbled";
  /** set when the text was read from the page image with OCR rather than extracted */
  ocr?: boolean;
}

export interface Extracted {
  title: string | null;
  author: string | null;
  year: number | null;
  pages: ExtractedPage[];
}

const MIN_CHARS = 25;

export function classifyPageText(text: string): "ok" | "empty" | "garbled" {
  const nonSpace = text.replace(/\s/g, "");
  if (nonSpace.length < MIN_CHARS) return "empty";
  const bad = (nonSpace.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  if (bad / nonSpace.length > 0.1) return "garbled";
  return "ok";
}

// ---------- PDF ----------

function pdfYear(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/D:(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1500 && y <= 2200 ? y : null;
}

export async function extractPdf(data: Uint8Array): Promise<Extracted> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  let title: string | null = null;
  let author: string | null = null;
  let year: number | null = null;
  try {
    const meta = await doc.getMetadata();
    const info = (meta.info ?? {}) as Record<string, unknown>;
    if (typeof info.Title === "string" && info.Title.trim()) title = info.Title.trim();
    if (typeof info.Author === "string" && info.Author.trim()) author = info.Author.trim();
    year = pdfYear(info.CreationDate) ?? pdfYear(info.ModDate);
  } catch {
    // metadata is optional
  }

  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = itemsToPageText(tc.items as unknown as PdfItem[]);
      pages.push({ page: i, text, status: classifyPageText(text) });
      page.cleanup();
    } catch {
      pages.push({ page: i, text: "", status: "empty" });
    }
  }
  await doc.destroy();
  return { title, author, year, pages };
}

// ---------- text / markdown ----------

const VIRTUAL_PAGE_CHARS = 2500;

export function extractText(raw: string, kind: DocKind): Extracted {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pages: ExtractedPage[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    const t = cur.join("\n\n");
    pages.push({ page: pages.length + 1, text: t, status: classifyPageText(t) });
    cur = [];
    len = 0;
  };
  for (const p of paragraphs) {
    if (len > 0 && len + p.length > VIRTUAL_PAGE_CHARS) flush();
    cur.push(p);
    len += p.length;
  }
  flush();

  let title: string | null = null;
  if (kind === "markdown") {
    const m = text.match(/^#{1,3}\s+(.+)$/m);
    if (m) title = m[1].trim();
  }
  if (!title) {
    const first = paragraphs[0]?.split("\n")[0]?.trim();
    if (first && first.length <= 100) title = first.replace(/^#+\s*/, "");
  }
  return { title, author: null, year: null, pages };
}
