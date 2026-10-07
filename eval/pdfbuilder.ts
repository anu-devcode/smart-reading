// Minimal PDF writer used only to create deterministic test fixtures.
// Text pages (Helvetica), a drawing-only page, and a scanned page (a raster image of text, no text layer).
import { createCanvas } from "@napi-rs/canvas";

export type PageSpec =
  | { paragraphs: string[] }
  | { drawingOnly: true }
  /** A page that is only a picture of these paragraphs (a 1-bit scan), like a scanned book page. */
  | { scanned: string[] }
  /**
   * Two text columns. The content stream is written row by row (left line, right line, next row),
   * the way many real PDFs are, so naive extraction interleaves the columns.
   * `heading` is a full-width line above the columns.
   */
  | { columns: [string[], string[]]; heading?: string };

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text: string, max = 88): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const SCAN_DPI = 200;
const SCAN_W = Math.round(8.5 * SCAN_DPI);
const SCAN_H = 11 * SCAN_DPI;

/** Draw paragraphs onto a white page and return it as a 1-bit image, hex-encoded for the PDF. */
function scanImage(paragraphs: string[]): string {
  const canvas = createCanvas(SCAN_W, SCAN_H);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, SCAN_W, SCAN_H);
  g.fillStyle = "#000";
  g.font = "34px sans-serif";
  const margin = SCAN_DPI; // 1 inch
  let y = margin + 40;
  for (const p of paragraphs) {
    let line = "";
    for (const word of p.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > SCAN_W - 2 * margin && line) {
        g.fillText(line, margin, y);
        y += 48;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) {
      g.fillText(line, margin, y);
      y += 48;
    }
    y += 48; // paragraph gap
  }
  const px = g.getImageData(0, 0, SCAN_W, SCAN_H).data;
  const rowBytes = Math.ceil(SCAN_W / 8);
  const bytes = Buffer.alloc(rowBytes * SCAN_H, 0);
  for (let row = 0; row < SCAN_H; row++) {
    for (let x = 0; x < SCAN_W; x++) {
      const i = (row * SCAN_W + x) * 4;
      const white = px[i] + px[i + 1] + px[i + 2] > 3 * 128;
      if (white) bytes[row * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bytes.toString("hex") + ">";
}

function pageStream(spec: PageSpec): string {
  if ("scanned" in spec) return "q 612 0 0 792 0 0 cm /Im0 Do Q";
  if ("drawingOnly" in spec) {
    // Filled rectangles only: renders as a page, yields no text (simulates a scan).
    return "0.8 g 72 600 400 100 re f 0.4 g 72 400 300 150 re f";
  }
  if ("columns" in spec) {
    const col = (paras: string[]) => {
      const out: string[] = [];
      for (const p of paras) {
        out.push(...wrap(p, 38), ""); // "" = paragraph gap
      }
      return out;
    };
    const L = col(spec.columns[0]);
    const R = col(spec.columns[1]);
    const ops2: string[] = [];
    let top = 740;
    if (spec.heading) {
      ops2.push(`BT /F1 16 Tf 72 ${top} Td (${esc(spec.heading)}) Tj ET`);
      top -= 40;
    }
    for (let i = 0; i < Math.max(L.length, R.length); i++) {
      const y = top - i * 14;
      if (L[i]) ops2.push(`BT /F1 11 Tf 72 ${y} Td (${esc(L[i])}) Tj ET`);
      if (R[i]) ops2.push(`BT /F1 11 Tf 330 ${y} Td (${esc(R[i])}) Tj ET`);
    }
    return ops2.join("\n");
  }
  const ops: string[] = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"];
  for (const p of spec.paragraphs) {
    for (const line of wrap(p)) ops.push(`(${esc(line)}) Tj T*`);
    ops.push("T*"); // blank line between paragraphs
  }
  ops.push("ET");
  return ops.join("\n");
}

export function buildPdf(pages: PageSpec[], title = "Fixture", outline: { title: string; page: number }[] = []): Buffer {
  const objects: string[] = [];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, 4 info, then page/content pairs
  const pageObjNums = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((x) => `${x} 0 R`).join(" ")}] /Count ${n} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[4] = `<< /Title (${esc(title)}) /Author (Fixture Author) >>`;
  let nextObj = 5 + n * 2; // image objects follow the page/content pairs
  pages.forEach((spec, i) => {
    const pageNum = 5 + i * 2;
    const contentNum = pageNum + 1;
    const stream = pageStream(spec);
    let xobjects = "";
    if ("scanned" in spec) {
      const imageNum = nextObj++;
      const hex = scanImage(spec.scanned);
      objects[imageNum] =
        `<< /Type /XObject /Subtype /Image /Width ${SCAN_W} /Height ${SCAN_H} /ColorSpace /DeviceGray /BitsPerComponent 1 ` +
        `/Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`;
      xobjects = `/XObject << /Im0 ${imageNum} 0 R >>`;
    }
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${xobjects} >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  if (outline.length) {
    // a flat bookmark list (the PDF's own table of contents)
    const root = nextObj++;
    const nums = outline.map(() => nextObj++);
    outline.forEach((o, i) => {
      const links = `${i > 0 ? `/Prev ${nums[i - 1]} 0 R ` : ""}${i < nums.length - 1 ? `/Next ${nums[i + 1]} 0 R ` : ""}`;
      objects[nums[i]] = `<< /Title (${esc(o.title)}) /Parent ${root} 0 R ${links}/Dest [${pageObjNums[o.page - 1]} 0 R /Fit] >>`;
    });
    objects[root] = `<< /Type /Outlines /First ${nums[0]} 0 R /Last ${nums[nums.length - 1]} 0 R /Count ${nums.length} >>`;
    objects[1] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R >>`;
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
