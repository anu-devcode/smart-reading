// Whitespace/quote-insensitive text normalisation shared by the server (anchoring selections to the
// extracted page text) and the web reader (locating highlights inside the rendered text layer).
// Both sides MUST use exactly this code so a selection maps to the same span everywhere.

const IGNORED = /[\s\u00AD\u200B-\u200D\uFEFF]/;

export function normChar(c: string): string {
  switch (c) {
    case "\u2018":
    case "\u2019":
    case "\u201B":
      return "'";
    case "\u201C":
    case "\u201D":
      return '"';
    case "\u2013":
    case "\u2014":
    case "\u2212":
      return "-";
    default: {
      const l = c.toLowerCase();
      return l.length === 1 ? l : c;
    }
  }
}

export interface Compact {
  /** lowercased text with whitespace removed and quotes/dashes unified */
  compact: string;
  /** compact index -> index in the original string */
  map: number[];
}

export function compactWithMap(s: string): Compact {
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (IGNORED.test(ch)) continue;
    compact += normChar(ch);
    map.push(i);
  }
  return { compact, map };
}

export function compactOf(s: string): string {
  return compactWithMap(s).compact;
}
