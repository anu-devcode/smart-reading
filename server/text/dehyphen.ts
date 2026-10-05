/**
 * Words broken by a hyphen at a line end ("inter-" / "national") come out of PDF extraction as
 * "inter- national": the lines are joined with a single space. Typed hyphens are never followed by a
 * space, so "letters, hyphen, space, lowercase letters" is a reliable signature of a line-end break.
 *
 * This is ONLY used to build the search index and the embedding input. Stored page text, passages and
 * quotes keep the original characters, so anchoring and "a quote is an exact substring" are unaffected.
 *
 * Trade-off: a real compound that happened to break at a line end ("well-" / "known") is indexed as
 * "wellknown". That is rare and the words are still found in the stored text.
 */
const LINE_END_HYPHEN = /(\p{L}{2,})[-\u2010\u00AD]\s+(\p{Ll}{2,})/gu;

export function forIndex(text: string): string {
  return text.replace(LINE_END_HYPHEN, "$1$2");
}
