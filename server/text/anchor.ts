// Text anchoring. The single most important guarantee of the product:
// anything stored as a Quote or source passage is an EXACT slice of the extracted page text,
// because we always store pageText.slice(start, end) and never the raw selection string.

import { compactOf, compactWithMap } from "../../shared/compact.ts";

export { compactOf, compactWithMap };
export type { Compact } from "../../shared/compact.ts";

export interface Span {
  start: number;
  end: number;
  text: string;
  occurrences: number;
}

/**
 * Find the span of `pageText` that corresponds to a selection copied from a rendered view.
 * Whitespace and quote style are ignored in matching; the returned text is the page's own text.
 * `hint` is an approximate compact-offset of the selection start, used to choose between repeats.
 */
export function findSpan(pageText: string, selection: string, hint?: number): Span | null {
  const sel = compactOf(selection);
  if (sel.length === 0) return null;
  const page = compactWithMap(pageText);
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = page.compact.indexOf(sel, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  if (hits.length === 0) return null;
  let best = hits[0];
  if (hint !== undefined && hits.length > 1) {
    best = hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a));
  }
  const start = page.map[best];
  const end = page.map[best + sel.length - 1] + 1;
  return { start, end, text: pageText.slice(start, end), occurrences: hits.length };
}

export interface AnchorRecord {
  text: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export const CONTEXT_CHARS = 32;

export function makeAnchor(pageText: string, start: number, end: number): AnchorRecord {
  return {
    text: pageText.slice(start, end),
    prefix: pageText.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: pageText.slice(end, end + CONTEXT_CHARS),
    start,
    end,
  };
}

/**
 * Re-anchor a stored span in (possibly changed) page text.
 * 1. If the old range still holds the same text, keep it.
 * 2. Otherwise find exact occurrences and pick the one whose surroundings best match the stored prefix/suffix.
 * 3. Otherwise try a whitespace/quote-insensitive match.
 * Returns null when the text can no longer be found (caller marks the highlight stale).
 */
export function reanchor(pageText: string, a: AnchorRecord): { start: number; end: number } | null {
  if (a.end <= pageText.length && pageText.slice(a.start, a.end) === a.text) {
    return { start: a.start, end: a.end };
  }
  const candidates: number[] = [];
  let from = 0;
  for (;;) {
    const idx = pageText.indexOf(a.text, from);
    if (idx === -1) break;
    candidates.push(idx);
    from = idx + 1;
  }
  if (candidates.length > 0) {
    const score = (idx: number) => {
      const before = pageText.slice(Math.max(0, idx - a.prefix.length), idx);
      const after = pageText.slice(idx + a.text.length, idx + a.text.length + a.suffix.length);
      return commonSuffix(before, a.prefix) + commonPrefix(after, a.suffix);
    };
    const best = candidates.reduce((x, y) => (score(y) > score(x) ? y : x));
    return { start: best, end: best + a.text.length };
  }
  const loose = findSpan(pageText, a.text, undefined);
  return loose ? { start: loose.start, end: loose.end } : null;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** Bounds of the paragraph(s) (blank-line separated blocks) that touch [start, end). */
export function paragraphBounds(pageText: string, start: number, end: number): { start: number; end: number } {
  let ps = pageText.lastIndexOf("\n\n", Math.max(0, start - 1));
  ps = ps === -1 ? 0 : ps + 2;
  let pe = pageText.indexOf("\n\n", end);
  pe = pe === -1 ? pageText.length : pe;
  return { start: ps, end: pe };
}
