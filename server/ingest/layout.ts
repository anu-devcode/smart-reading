/**
 * Reconstruct reading-order text from pdf.js text items.
 *
 * - Items are grouped into rows by baseline.
 * - Column gutters are detected from where text is (not) present across many rows. Pages without a
 *   gutter are read exactly as before: top to bottom, one column.
 * - With gutters, full-width rows (headings, wide figures captions, page numbers in the middle) split the
 *   page into blocks; inside each block the left column is read completely, then the next one.
 * - Paragraph breaks come from unusually large vertical gaps.
 *
 * Known gap: a table with text columns is read column by column, not row by row.
 */

export type PdfItem = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };

interface Item {
  str: string;
  x0: number;
  x1: number;
  y: number;
  h: number;
  /** whitespace-only spacer inserted by pdf.js; its width can span a whole gutter, so it says nothing about where text is */
  blank: boolean;
}

interface Row {
  y: number;
  h: number;
  items: Item[];
}

interface Line extends Row {
  /** a break in reading flow precedes this line (new column, or after a full-width row) */
  breakBefore: boolean;
  /** the break comes from moving to another column, so a sentence may continue across it */
  columnBreak: boolean;
}

function toItems(items: PdfItem[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (typeof it.str !== "string" || it.str.length === 0) continue;
    const h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
    const x0 = it.transform[4];
    const w = it.width || it.str.length * h * 0.5;
    out.push({ str: it.str, x0, x1: x0 + w, y: it.transform[5], h, blank: it.str.trim() === "" });
  }
  return out;
}

function clusterRows(items: Item[]): Row[] {
  const rows: Row[] = [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, r.h * 0.4));
    if (row) row.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) r.items.sort((a, b) => a.x0 - b.x0);
  return rows;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Text intervals of a row: items closer than ~1.5 line heights are one run of text. */
function rowRuns(r: Row): [number, number][] {
  const runs: [number, number][] = [];
  for (const it of r.items) {
    if (it.blank) continue;
    const last = runs[runs.length - 1];
    if (last && it.x0 - last[1] <= r.h * 1.5) last[1] = Math.max(last[1], it.x1);
    else runs.push([it.x0, it.x1]);
  }
  return runs;
}

const MIN_ROWS = 8;
const MAX_GUTTERS = 2;

/** x positions (page units) of column gutters; [] for a single-column page. */
export function detectGutters(rows: Row[]): number[] {
  if (rows.length < MIN_ROWS) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const r of rows) {
    for (const it of r.items) {
      if (it.blank) continue;
      minX = Math.min(minX, it.x0);
      maxX = Math.max(maxX, it.x1);
    }
  }
  const W = maxX - minX;
  if (!(W >= 250)) return [];
  const medH = median(rows.map((r) => r.h)) || 10;

  const n = Math.ceil(W) + 2;
  const cover = new Int32Array(n);
  const runsByRow = rows.map(rowRuns);
  for (const runs of runsByRow) {
    for (const [a, b] of runs) {
      const lo = Math.max(0, Math.floor(a - minX));
      const hi = Math.min(n - 1, Math.ceil(b - minX));
      for (let i = lo; i <= hi; i++) cover[i]++;
    }
  }

  const tolerance = Math.max(1, Math.floor(rows.length * 0.08));
  const minWidth = Math.max(8, medH * 1.0);
  const lo = Math.floor(W * 0.15);
  const hi = Math.ceil(W * 0.85);

  const found: { center: number; both: number }[] = [];
  let i = lo;
  while (i <= hi) {
    if (cover[i] > tolerance) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 <= hi && cover[j + 1] <= tolerance) j++;
    if (j - i + 1 >= minWidth) {
      const a = minX + i;
      const b = minX + j;
      let left = 0;
      let right = 0;
      let both = 0;
      for (const runs of runsByRow) {
        const l = runs.some(([, x1]) => x1 <= a);
        const r = runs.some(([x0]) => x0 >= b);
        if (l) left++;
        if (r) right++;
        if (l && r) both++;
      }
      // Real columns have text on both sides of the gap in a good share of the rows.
      // A ragged right edge or an indented block does not.
      if (left >= rows.length * 0.3 && right >= rows.length * 0.3 && both >= Math.max(4, rows.length * 0.25)) {
        found.push({ center: (a + b) / 2, both });
      }
    }
    i = j + 1;
  }
  return found
    .sort((x, y) => y.both - x.both)
    .slice(0, MAX_GUTTERS)
    .map((f) => f.center)
    .sort((x, y) => x - y);
}

function lineText(l: Row): string {
  let s = "";
  let prevEnd: number | null = null;
  for (const it of l.items) {
    if (prevEnd !== null && s && !s.endsWith(" ") && !it.str.startsWith(" ")) {
      if (it.x0 - prevEnd > l.h * 0.15) s += " ";
    }
    s += it.str;
    prevEnd = it.x1;
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Lines in reading order with markers for where the flow breaks. */
function readingOrder(rows: Row[], gutters: number[]): Line[] {
  const seq: Line[] = [];
  if (gutters.length === 0) {
    for (const r of rows) seq.push({ ...r, breakBefore: false, columnBreak: false });
    return seq;
  }
  const colOf = (it: Item) => gutters.filter((g) => g < it.x0 + 1).length;
  const spans = (r: Row) => r.items.some((it) => !it.blank && gutters.some((g) => it.x0 < g - 1 && it.x1 > g + 1));

  let block: Row[] = [];
  const flush = () => {
    for (let c = 0; c <= gutters.length; c++) {
      let first = true;
      for (const r of block) {
        const its = r.items.filter((it) => colOf(it) === c);
        if (!its.length) continue;
        seq.push({ y: r.y, h: r.h, items: its, breakBefore: first && seq.length > 0, columnBreak: first && c > 0 });
        first = false;
      }
    }
    block = [];
  };
  for (const r of rows) {
    if (spans(r)) {
      flush();
      seq.push({ ...r, breakBefore: seq.length > 0, columnBreak: false });
    } else block.push(r);
  }
  flush();
  return seq;
}

const TERMINAL = /[.!?:;"'\u201D\u2019)\]]$/;

export function itemsToPageText(items: PdfItem[]): string {
  const its = toItems(items);
  if (its.length === 0) return "";
  const rows = clusterRows(its);
  const seq = readingOrder(rows, detectGutters(rows));

  const gaps: number[] = [];
  for (let i = 1; i < seq.length; i++) if (!seq[i].breakBefore) gaps.push(seq[i - 1].y - seq[i].y);
  const med = median(gaps);

  let out = "";
  seq.forEach((l, i) => {
    const t = lineText(l);
    if (!t) return;
    if (i === 0 || !out) {
      out += t;
      return;
    }
    if (l.breakBefore) {
      // A sentence that runs from the bottom of one column to the top of the next is one paragraph.
      const continues = l.columnBreak && !TERMINAL.test(out) && /^\p{Ll}/u.test(t);
      out += continues ? " " + t : "\n\n" + t;
      return;
    }
    const gap = seq[i - 1].y - l.y;
    out += med > 0 && gap > med * 1.45 ? "\n\n" + t : " " + t;
  });
  return out.trim();
}
