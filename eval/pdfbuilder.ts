// Minimal PDF writer used only to create deterministic test fixtures.
// Text-only pages (Helvetica) plus an "image-like" page with no extractable text.

export type PageSpec = { paragraphs: string[] } | { drawingOnly: true };

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

function pageStream(spec: PageSpec): string {
  if ("drawingOnly" in spec) {
    // Filled rectangles only: renders as a page, yields no text (simulates a scan).
    return "0.8 g 72 600 400 100 re f 0.4 g 72 400 300 150 re f";
  }
  const ops: string[] = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"];
  for (const p of spec.paragraphs) {
    for (const line of wrap(p)) ops.push(`(${esc(line)}) Tj T*`);
    ops.push("T*"); // blank line between paragraphs
  }
  ops.push("ET");
  return ops.join("\n");
}

export function buildPdf(pages: PageSpec[], title = "Fixture"): Buffer {
  const objects: string[] = [];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, 4 info, then page/content pairs
  const pageObjNums = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((x) => `${x} 0 R`).join(" ")}] /Count ${n} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[4] = `<< /Title (${esc(title)}) /Author (Fixture Author) >>`;
  pages.forEach((spec, i) => {
    const pageNum = 5 + i * 2;
    const contentNum = pageNum + 1;
    const stream = pageStream(spec);
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

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
