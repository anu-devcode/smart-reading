import { compactWithMap } from "../../../shared/compact";

// Locate text inside a rendered text layer, using the SAME normalisation as the server
// (shared/compact.ts), so a selection or a stored highlight maps to the same span on both sides.

export interface TextIndex {
  nodes: Text[];
  compact: string;
  /** compact index -> index into nodes */
  nodeOf: number[];
  /** compact index -> character offset inside that node */
  offsetOf: number[];
}

export function buildTextIndex(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  let compact = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const idx = nodes.push(t) - 1;
    const c = compactWithMap(t.data);
    compact += c.compact;
    for (const k of c.map) {
      nodeOf.push(idx);
      offsetOf.push(k);
    }
  }
  return { nodes, compact, nodeOf, offsetOf };
}

/** Find `text` in the index; when it occurs several times, pick the occurrence nearest `hint` (compact offset). */
export function locateRange(ix: TextIndex, text: string, hint?: number): Range | null {
  const q = compactWithMap(text).compact;
  if (!q) return null;
  const hits: number[] = [];
  for (let from = 0; ; ) {
    const i = ix.compact.indexOf(q, from);
    if (i === -1) break;
    hits.push(i);
    from = i + 1;
  }
  if (!hits.length) return null;
  let best = hits[0];
  if (hint !== undefined && hits.length > 1) {
    best = hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a));
  }
  const last = best + q.length - 1;
  const range = document.createRange();
  range.setStart(ix.nodes[ix.nodeOf[best]], ix.offsetOf[best]);
  range.setEnd(ix.nodes[ix.nodeOf[last]], ix.offsetOf[last] + 1);
  return range;
}

/** Compact offset of the start of a DOM range (used to disambiguate repeated text). */
export function compactOffsetOfRange(ix: TextIndex, range: Range): number | undefined {
  const container = range.startContainer;
  let nodeIdx = -1;
  let off = range.startOffset;
  if (container.nodeType === Node.TEXT_NODE) {
    nodeIdx = ix.nodes.indexOf(container as Text);
  } else {
    const child = container.childNodes[range.startOffset] ?? null;
    if (child) {
      const w = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      const first = w.nextNode() as Text | null;
      if (first) {
        nodeIdx = ix.nodes.indexOf(first);
        off = 0;
      }
    }
  }
  if (nodeIdx < 0) return undefined;
  for (let k = 0; k < ix.nodeOf.length; k++) {
    if (ix.nodeOf[k] > nodeIdx || (ix.nodeOf[k] === nodeIdx && ix.offsetOf[k] >= off)) return k;
  }
  return ix.nodeOf.length;
}

/** Client rects of a range, relative to a container element. */
export function rectsRelativeTo(range: Range, container: HTMLElement): { x: number; y: number; w: number; h: number }[] {
  const base = container.getBoundingClientRect();
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }));
}
