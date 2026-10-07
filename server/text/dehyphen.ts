/**
 * Words broken by a hyphen at a line end ("inter-" / "national") come out of PDF extraction as
 * "inter- national": the lines are joined with a single space. Typed hyphens are never followed by a
 * space, so "letters, hyphen, space, lowercase letters" is a reliable signature of a line-end break.
 *
 * The open question is whether the hyphen was *soft* (a hyphenation point: "inter-national" is the word
 * "international") or *real* (a compound that happened to break there: "well-known"). We decide per word
 * from the document itself:
 *   - the document also contains "left-right" typed with a hyphen  -> compound
 *   - the document also contains "leftright" as a plain word        -> soft
 *   - otherwise (no evidence)                                      -> soft, the common case
 * and, because a guess can be wrong, BOTH readings are always searchable: the chosen one goes in the
 * main index column and the other one in an `alt` column.
 *
 * This only feeds the search index and embeddings. Stored page text, passages and quotes keep the
 * original characters, so anchoring and "a quote is an exact substring" are unaffected.
 */
import type { DB } from "../db.ts";

const BREAK = /(\p{L}{2,})[-\u2010\u00AD]\s+(\p{Ll}{2,})/gu;
const TYPED_COMPOUND = /(\p{L}{2,})[-\u2010](\p{L}{2,})/gu;
const WORD = /\p{L}+/gu;

export interface HyphenVocab {
  /** lowercase words that appear as plain words */
  words: Set<string>;
  /** "leftright" for each "left-right" typed with a hyphen inside a line */
  compounds: Set<string>;
}

export function buildVocab(texts: string[]): HyphenVocab {
  const words = new Set<string>();
  const compounds = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(TYPED_COMPOUND)) compounds.add((m[1] + m[2]).toLowerCase());
    for (const m of t.matchAll(WORD)) words.add(m[0].toLowerCase());
  }
  return { words, compounds };
}

export const EMPTY_VOCAB: HyphenVocab = { words: new Set(), compounds: new Set() };

export type Reading = "soft" | "compound";

export function decide(left: string, right: string, vocab: HyphenVocab): Reading {
  const joined = (left + right).toLowerCase();
  if (vocab.compounds.has(joined)) return "compound";
  if (vocab.words.has(joined)) return "soft";
  return "soft";
}

/**
 * Text for the main index column, plus the other reading of every broken word for the `alt` column.
 * `alt` is "" when the text has no line-end hyphens.
 */
export function indexVariants(text: string, vocab: HyphenVocab = EMPTY_VOCAB): { body: string; alt: string } {
  const alts: string[] = [];
  const body = text.replace(BREAK, (_m, left: string, right: string) => {
    if (decide(left, right, vocab) === "compound") {
      alts.push(left + right);
      return `${left}-${right}`;
    }
    alts.push(`${left} ${right}`);
    return left + right;
  });
  return { body, alt: alts.join(" ") };
}

/** Vocabulary-free, join-only form. Used where there is no document context (saved units). */
export function forIndex(text: string): string {
  return text.replace(BREAK, "$1$2");
}

/** Rebuild the keyword index of every passage (after a schema change). Pure derivation, safe to repeat. */
export function reindexPassages(db: DB): void {
  const docs = db.prepare("SELECT DISTINCT doc_id FROM passages").all() as { doc_id: number }[];
  const pages = db.prepare("SELECT text FROM pages WHERE doc_id = ?");
  const rows = db.prepare("SELECT id, text FROM passages WHERE doc_id = ?");
  const del = db.prepare("DELETE FROM passages_fts WHERE rowid = ?");
  const ins = db.prepare("INSERT INTO passages_fts(rowid, body, alt) VALUES (?,?,?)");
  const tx = db.transaction(() => {
    for (const { doc_id } of docs) {
      const vocab = buildVocab((pages.all(doc_id) as { text: string }[]).map((p) => p.text));
      for (const r of rows.all(doc_id) as { id: number; text: string }[]) {
        const v = indexVariants(r.text, vocab);
        del.run(r.id);
        ins.run(r.id, v.body, v.alt);
      }
    }
  });
  tx();
}
