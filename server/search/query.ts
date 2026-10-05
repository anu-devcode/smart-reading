import type { DocKind, ReadingStatus, UnitType } from "../../shared/types.ts";
import { READING_STATUSES, UNIT_TYPES } from "../../shared/types.ts";

// Turns what the user types into SAFE SQLite FTS5 expressions.
//
//   plain words            attention scarce            (AND first, falls back to OR when too few hits)
//   "exact phrase"         "scarce resource"
//   boolean (uppercase)    forgetting AND intervals,  memory NOT cramming,  (a OR b) AND c
//   prefix                 interrupt*
//   field scopes           title:complexity   author:smith   note:revisit
//   filters                type:idea   status:unread   kind:pdf
//
// User input is never passed to FTS5 raw: every word is quoted, so stray punctuation cannot cause syntax errors.

export interface ParsedQuery {
  raw: string;
  /** FTS expression for passage text and unit content (AND semantics) */
  bodyExpr: string | null;
  /** looser OR expression used as a fallback for plain natural-language queries */
  orExpr: string | null;
  /** title:/author: terms, applied to documents_fts */
  docExpr: string | null;
  /** note: terms, applied to units_fts */
  noteExpr: string | null;
  filters: { type?: UnitType; status?: ReadingStatus; kind?: DocKind };
  /** true when the query uses phrases, boolean operators, parentheses, prefixes or field scopes */
  structured: boolean;
  phrases: string[];
  words: string[];
  /** natural text sent to the embedding model */
  semanticText: string;
}

type Tok =
  | { t: "term"; fts: string; plain: string; phrase: boolean; prefix: boolean }
  | { t: "op"; v: "AND" | "OR" | "NOT" }
  | { t: "(" }
  | { t: ")" };

const STOPWORDS = new Set(
  "a an the and or of to in on at for with by from as is are was were be been it its this that these those do does did how why what when where which who whom i my me we our you your they them their he she his her not no so if then than too very can could would should will just about into over under again further more most other some such only own same".split(
    " ",
  ),
);

const FIELD_NAMES = new Set(["title", "author", "note", "body", "type", "status", "kind", "is"]);

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function cleanWord(w: string): string {
  return w.replace(/^[^\p{L}\p{N}*]+|[^\p{L}\p{N}*]+$/gu, "");
}

export function parseQuery(raw: string): ParsedQuery {
  const filters: ParsedQuery["filters"] = {};
  const bodyToks: Tok[] = [];
  const docTerms: string[] = [];
  const noteTerms: string[] = [];
  const phrases: string[] = [];
  const words: string[] = [];
  let structured = false;

  const s = raw.trim();
  let i = 0;
  const readPhrase = (): string => {
    // assumes s[i] === '"'
    let j = s.indexOf('"', i + 1);
    if (j === -1) j = s.length;
    const v = s.slice(i + 1, j).trim();
    i = Math.min(j + 1, s.length);
    return v;
  };

  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      const v = readPhrase();
      if (v) {
        bodyToks.push({ t: "term", fts: q(v), plain: v, phrase: true, prefix: false });
        phrases.push(v);
        structured = true;
      }
      continue;
    }
    if (c === "(" || c === ")") {
      bodyToks.push({ t: c });
      structured = true;
      i++;
      continue;
    }
    // a run of non-space, non-quote, non-paren characters
    let j = i;
    while (j < s.length && !/[\s"()]/.test(s[j])) j++;
    const chunk = s.slice(i, j);
    i = j;

    const fm = chunk.match(/^([A-Za-z]+):(.*)$/);
    if (fm && FIELD_NAMES.has(fm[1].toLowerCase())) {
      const name = fm[1].toLowerCase();
      let value = fm[2];
      let isPhrase = false;
      if (!value && s[i] === '"') {
        value = readPhrase();
        isPhrase = true;
      }
      if (!value) continue;
      if (name === "type") {
        const t = value.toLowerCase().replace(/s$/, "") as UnitType;
        if (UNIT_TYPES.includes(t)) filters.type = t;
      } else if (name === "status" || name === "is") {
        const v = value.toLowerCase() as ReadingStatus;
        if (READING_STATUSES.includes(v)) filters.status = v;
      } else if (name === "kind") {
        const v = value.toLowerCase();
        if (v === "pdf" || v === "text" || v === "markdown") filters.kind = v;
        else if (v === "md") filters.kind = "markdown";
        else if (v === "txt") filters.kind = "text";
      } else if (name === "title" || name === "author" || name === "note") {
        const w = isPhrase ? value : cleanWord(value);
        if (w) {
          (name === "note" ? noteTerms : docTerms).push(`${name}:${q(w.replace(/\*/g, ""))}${w.endsWith("*") && !isPhrase ? "*" : ""}`);
          structured = true;
        }
      } else {
        // body:word is the same as a plain word
        const w = cleanWord(value);
        if (w) bodyToks.push({ t: "term", fts: q(w.replace(/\*/g, "")), plain: w.replace(/\*/g, ""), phrase: false, prefix: false });
      }
      continue;
    }

    if (chunk === "AND" || chunk === "OR" || chunk === "NOT") {
      bodyToks.push({ t: "op", v: chunk });
      structured = true;
      continue;
    }

    const w = cleanWord(chunk);
    const bare = w.replace(/\*/g, "");
    if (!bare) continue;
    const prefix = w.endsWith("*");
    if (prefix) structured = true;
    bodyToks.push({ t: "term", fts: q(bare) + (prefix ? "*" : ""), plain: bare, phrase: false, prefix });
    words.push(bare);
  }

  const { expr, structuredBoolean } = assemble(bodyToks);
  if (structuredBoolean) structured = true;

  // OR fallback only makes sense for plain natural-language queries
  const termToks = bodyToks.filter((t): t is Extract<Tok, { t: "term" }> => t.t === "term");
  const hasOps = bodyToks.some((t) => t.t === "op" || t.t === "(" || t.t === ")");
  let orExpr: string | null = null;
  if (!hasOps && termToks.length > 1) {
    const meaningful = termToks.filter((t) => t.phrase || !STOPWORDS.has(t.plain.toLowerCase()));
    const use = meaningful.length ? meaningful : termToks;
    orExpr = use.map((t) => t.fts).join(" OR ");
  }

  const semanticText = termToks.map((t) => t.plain).join(" ").trim();

  return {
    raw,
    bodyExpr: expr,
    orExpr,
    docExpr: docTerms.length ? docTerms.join(" AND ") : null,
    noteExpr: noteTerms.length ? noteTerms.join(" AND ") : null,
    filters,
    structured,
    phrases,
    words,
    semanticText,
  };
}

/** Build a valid FTS5 expression from tokens: explicit AND between adjacent terms, no dangling operators. */
function assemble(toks: Tok[]): { expr: string | null; structuredBoolean: boolean } {
  // drop parentheses entirely if they do not balance
  let depth = 0;
  let balanced = true;
  for (const t of toks) {
    if (t.t === "(") depth++;
    if (t.t === ")") {
      depth--;
      if (depth < 0) balanced = false;
    }
  }
  if (depth !== 0) balanced = false;
  const work = balanced ? toks.slice() : toks.filter((t) => t.t !== "(" && t.t !== ")");

  const out: Tok[] = [];
  const isOperand = (t?: Tok) => !!t && (t.t === "term" || t.t === ")");
  for (const t of work) {
    const prev = out[out.length - 1];
    if (t.t === "op") {
      if (!isOperand(prev)) continue; // leading op, or op after op / "(": drop
      out.push(t);
    } else if (t.t === ")") {
      if (prev && prev.t === "op") out.pop(); // "a AND )" -> "a )"
      if (out[out.length - 1]?.t === "(") {
        out.pop(); // "()" -> nothing
        continue;
      }
      out.push(t);
    } else {
      // term or "("
      if (isOperand(prev)) out.push({ t: "op", v: "AND" }); // implicit AND
      out.push(t);
    }
  }
  while (out.length && out[out.length - 1].t === "op") out.pop();

  const parts = out.map((t) => (t.t === "term" ? t.fts : t.t === "op" ? t.v : t.t));
  const expr = parts.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
  return { expr: expr || null, structuredBoolean: out.some((t) => t.t === "op" && t.v !== "AND") };
}

/** Terms highlighted inside a snippet (text between \u0001 and \u0002). */
export function markedTerms(snippet: string): string[] {
  const seen = new Set<string>();
  const re = /\u0001([^\u0002]*)\u0002/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) seen.add(m[1].toLowerCase());
  return [...seen];
}
