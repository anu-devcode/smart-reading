// Types shared by the server and the web UI.

export type DocKind = "pdf" | "text" | "markdown";
export type ProcessingStatus = "processing" | "ready" | "partial" | "failed";
export type ReadingStatus = "unread" | "reading" | "finished" | "revisit";
export type UnitType = "quote" | "idea" | "concept" | "question";
export type Relation = "same_idea" | "supports" | "contradicts";

export const UNIT_TYPES: UnitType[] = ["quote", "idea", "concept", "question"];
export const READING_STATUSES: ReadingStatus[] = ["unread", "reading", "finished", "revisit"];
export const RELATIONS: Relation[] = ["same_idea", "supports", "contradicts"];

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
}

export interface PageDto {
  page: number;
  text: string;
  status: "ok" | "empty" | "garbled";
}

export interface HighlightDto {
  id: number;
  docId: number;
  page: number;
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
  page: number;
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
  anchor: { page: number; start: number; end: number; text: string };
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
  libraryDir: string;
}

export interface SettingsDto {
  ai: { baseUrl: string; model: string; apiKeySet: boolean };
}
