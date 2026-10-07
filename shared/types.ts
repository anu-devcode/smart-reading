// Types shared by the server and the web UI.

export type DocKind = "pdf" | "text" | "markdown";
export type ProcessingStatus = "processing" | "ready" | "partial" | "failed";
export type ReadingStatus = "unread" | "reading" | "finished" | "revisit";
export type UnitType = "quote" | "idea" | "concept" | "question";
export type Relation = "same_idea" | "supports" | "contradicts";

export const UNIT_TYPES: UnitType[] = ["quote", "idea", "concept", "question"];
export const READING_STATUSES: ReadingStatus[] = ["unread", "reading", "finished", "revisit"];
export const RELATIONS: Relation[] = ["same_idea", "supports", "contradicts"];

/** Text of consecutive pages is joined with this when a span crosses a page boundary. */
export const PAGE_JOIN = "\n\n";
/** The most pages one highlight or quote may cover. */
export const MAX_SPAN_PAGES = 5;

/** "p. 2" or "pp. 2-3" */
export function pagesLabel(page: number, endPage: number): string {
  return endPage > page ? `pp. ${page}\u2013${endPage}` : `p. ${page}`;
}

/** A unit as you would paste it elsewhere: a quote in quotation marks, your own words as they are, then the source. */
export function citationText(u: {
  type: UnitType;
  content: string;
  docTitle: string;
  docAuthor: string | null;
  docYear: number | null;
  page: number;
  endPage: number;
}): string {
  const source = `${u.docAuthor ? `${u.docAuthor}, ` : ""}${u.docTitle}${u.docYear ? ` (${u.docYear})` : ""}, ${pagesLabel(u.page, u.endPage)}`;
  const content = u.content.replace(/\s+/g, " ").trim();
  return u.type === "quote" ? `\u201C${content}\u201D \u2014 ${source}` : `${content}\n(${source})`;
}

export interface DocumentDto {
  id: number;
  title: string;
  author: string | null;
  year: number | null;
  kind: DocKind;
  originalName: string;
  pageCount: number;
  processingStatus: ProcessingStatus;
  readingStatus: ReadingStatus;
  failureNotes: string[];
  addedAt: string;
  unitCount: number;
  /** pending = meaning-search index still being built for this document */
  embeddingPending: boolean;
  /** scanned pages still waiting to be read with OCR (the document counts as processing meanwhile) */
  ocrPending: number;
}

export interface PageDto {
  page: number;
  text: string;
  status: "ok" | "empty" | "garbled";
  /** the text of this page was recognised from an image (OCR) and may contain recognition mistakes */
  ocr: boolean;
}

/** One recognised word of an OCR page: its place in the page text and its box on the page (0..1 of width/height). */
export interface OcrWordDto {
  s: number;
  e: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A span of a document. It starts at `start` on `page` and ends at `end` on `endPage` (= `page` for the usual
 * single-page case). A span over several pages has the text of each page joined with PAGE_JOIN.
 */
export interface HighlightDto {
  id: number;
  docId: number;
  page: number;
  endPage: number;
  start: number;
  end: number;
  text: string;
  note: string | null;
  stale: boolean;
}

export interface UnitDto {
  id: number;
  type: UnitType;
  content: string;
  docId: number;
  docTitle: string;
  docAuthor: string | null;
  docYear: number | null;
  page: number;
  endPage: number;
  start: number;
  end: number;
  sourceText: string;
  passageId: number | null;
  highlightId: number | null;
  note: string | null;
  origin: "manual" | "distill";
  edited: boolean;
  acceptedAt: string;
}

export interface UnitContextDto {
  unit: UnitDto;
  /** The paragraph(s) around the source span, from the document text. */
  paragraph: string;
  paragraphStart: number;
  links: { id: number; relation: Relation; direction: "out" | "in"; other: UnitDto }[];
}

export interface Why {
  lexical: boolean;
  /** cosine similarity of the meaning match, or null when meaning search did not contribute */
  semantic: number | null;
  exactPhrase: boolean;
  terms: string[];
  titleMatch?: boolean;
}

export interface PassageHit {
  passageId: number;
  docId: number;
  docTitle: string;
  page: number;
  start: number;
  end: number;
  text: string;
  /** Snippet with \u0001 and \u0002 around matched terms */
  snippet: string;
  why: Why;
  score: number;
}

export interface UnitHit {
  unit: UnitDto;
  snippet: string;
  why: Why;
  score: number;
}

export interface FileHit {
  docId: number;
  title: string;
  author: string | null;
  kind: DocKind;
  passageHits: number;
  unitCount: number;
  titleMatch: boolean;
}

export interface SearchResponse {
  query: string;
  interpreted: {
    structured: boolean;
    filters: { type?: UnitType; status?: ReadingStatus; kind?: DocKind };
    semantic: "used" | "unavailable" | "skipped";
    mode: "and" | "or" | "none";
  };
  saved: {
    counts: Record<UnitType, number>;
    units: UnitHit[];
  };
  passages: PassageHit[];
  files: FileHit[];
}

export interface Candidate {
  type: Exclude<UnitType, "quote">;
  text: string;
  /** verbatim from the source paragraph (verified server-side) */
  supportingQuote: string;
}

export interface DistillResponse {
  candidates: Candidate[];
  dropped: number;
  anchor: { page: number; endPage: number; start: number; end: number; text: string };
}

export interface CreateUnitResponse {
  unit: UnitDto;
  suggestion: { unit: UnitDto; similarity: number } | null;
}

export interface CollectionDto {
  id: number;
  name: string;
  query: string;
}

export interface StatusDto {
  embedding: {
    state: "off" | "idle" | "working" | "unavailable";
    model: string;
    pending: number;
    error?: string;
  };
  ai: { configured: boolean; model: string | null };
  ocr: { enabled: boolean; language: string; state: "off" | "idle" | "working" | "unavailable"; pending: number; error?: string };
  libraryDir: string;
}

export interface SettingsDto {
  ai: { baseUrl: string; model: string; apiKeySet: boolean };
  ocr: { enabled: boolean; language: string };
}

export interface AccountDto {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface SessionDto {
  /** false = a single library on this computer with no sign-in */
  accounts: boolean;
  /** no account exists yet: the first person to open the app creates the owner account */
  setupNeeded: boolean;
  account: AccountDto | null;
}
