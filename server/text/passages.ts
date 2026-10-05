// Preprocessing: page text -> passages.
// Passages never cross a page, so every passage has a clean page anchor.
// They are kept short (<= MAX_WORDS) because the embedding model truncates long inputs.

export const MAX_WORDS = 90;
const MIN_BLOCK_WORDS = 8;

export interface PassageSpan {
  start: number;
  end: number;
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Split page text into blank-line separated blocks with offsets. */
function blocks(text: string): PassageSpan[] {
  const out: PassageSpan[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ start: last, end: text.length });
  return out.filter((b) => text.slice(b.start, b.end).trim().length > 0);
}

/** Split a block into sentence-bounded chunks no longer than MAX_WORDS. */
function chunkBlock(text: string, b: PassageSpan): PassageSpan[] {
  const body = text.slice(b.start, b.end);
  if (wordCount(body) <= MAX_WORDS) return [b];

  // sentence boundaries with offsets
  const sentences: PassageSpan[] = [];
  const re = /[.!?\u061F\u3002]+["')\]]*\s+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const end = m.index + m[0].length;
    sentences.push({ start: last, end });
    last = end;
  }
  if (last < body.length) sentences.push({ start: last, end: body.length });

  const out: PassageSpan[] = [];
  let cur: PassageSpan | null = null;
  let curWords = 0;
  const flush = () => {
    if (cur) out.push({ start: b.start + cur.start, end: b.start + cur.end });
    cur = null;
    curWords = 0;
  };
  for (const s of sentences) {
    const sw = wordCount(body.slice(s.start, s.end));
    if (sw > MAX_WORDS) {
      flush();
      // hard split a very long sentence on word boundaries
      const wre = /\S+\s*/g;
      let wm: RegExpExecArray | null;
      let segStart = s.start;
      let n = 0;
      while ((wm = wre.exec(body.slice(s.start, s.end)))) {
        n++;
        if (n === MAX_WORDS) {
          const segEnd = s.start + wm.index + wm[0].length;
          out.push({ start: b.start + segStart, end: b.start + segEnd });
          segStart = segEnd;
          n = 0;
        }
      }
      if (segStart < s.end) out.push({ start: b.start + segStart, end: b.start + s.end });
      continue;
    }
    if (cur && curWords + sw > MAX_WORDS) flush();
    cur = cur ? { start: cur.start, end: s.end } : { start: s.start, end: s.end };
    curWords += sw;
  }
  flush();
  return out;
}

export function splitPassages(pageText: string): PassageSpan[] {
  const bs = blocks(pageText);
  // merge very short blocks (headings, captions) into the following block
  const merged: PassageSpan[] = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (wordCount(pageText.slice(b.start, b.end)) < MIN_BLOCK_WORDS && i + 1 < bs.length) {
      bs[i + 1] = { start: b.start, end: bs[i + 1].end };
      continue;
    }
    merged.push(b);
  }
  const out: PassageSpan[] = [];
  for (const b of merged) out.push(...chunkBlock(pageText, b));
  return out.map((s) => trimSpan(pageText, s)).filter((s) => s.end > s.start);
}

function trimSpan(text: string, s: PassageSpan): PassageSpan {
  let { start, end } = s;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}
