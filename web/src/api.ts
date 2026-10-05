import type {
  CollectionDto,
  CreateUnitResponse,
  DistillResponse,
  DocumentDto,
  HighlightDto,
  PageDto,
  ReadingStatus,
  Relation,
  SearchResponse,
  SettingsDto,
  StatusDto,
  UnitContextDto,
  UnitDto,
  UnitType,
} from "../../shared/types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`) as Error & { status?: number; data?: any };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export interface UploadResult {
  name: string;
  document?: DocumentDto;
  duplicate?: boolean;
  error?: string;
}

export interface SelectionRef {
  docId: number;
  page: number;
  selectionText: string;
  hint?: number;
}

export const api = {
  status: () => req<StatusDto>("GET", "/api/status"),
  documents: () => req<DocumentDto[]>("GET", "/api/documents"),
  document: (id: number) => req<DocumentDto>("GET", `/api/documents/${id}`),
  pages: (id: number) => req<PageDto[]>("GET", `/api/documents/${id}/pages`),
  patchDocument: (id: number, p: { title?: string; author?: string | null; year?: number | null; readingStatus?: ReadingStatus }) =>
    req<DocumentDto>("PATCH", `/api/documents/${id}`, p),
  deleteDocument: (id: number, force = false) => req<{ ok: true }>("DELETE", `/api/documents/${id}${force ? "?force=1" : ""}`),
  upload: async (files: File[]): Promise<UploadResult[]> => {
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f, f.name));
    const res = await fetch("/api/documents", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Upload failed");
    return res.json();
  },
  search: (q: string) => req<SearchResponse>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  passage: (id: number) => req<{ id: number; docId: number; page: number; start: number; end: number; text: string }>("GET", `/api/passages/${id}`),

  collections: () => req<CollectionDto[]>("GET", "/api/collections"),
  addCollection: (name: string, query: string) => req<CollectionDto>("POST", "/api/collections", { name, query }),
  deleteCollection: (id: number) => req<{ ok: true }>("DELETE", `/api/collections/${id}`),

  highlights: (docId: number) => req<HighlightDto[]>("GET", `/api/documents/${docId}/highlights`),
  addHighlight: (s: SelectionRef & { note?: string | null }) => req<HighlightDto>("POST", "/api/highlights", s),
  updateHighlight: (id: number, note: string | null) => req<HighlightDto>("PATCH", `/api/highlights/${id}`, { note }),
  deleteHighlight: (id: number) => req<{ ok: true }>("DELETE", `/api/highlights/${id}`),

  units: (f: { type?: UnitType; docId?: number } = {}) => {
    const p = new URLSearchParams();
    if (f.type) p.set("type", f.type);
    if (f.docId) p.set("docId", String(f.docId));
    return req<UnitDto[]>("GET", `/api/units?${p}`);
  },
  unit: (id: number) => req<UnitContextDto>("GET", `/api/units/${id}`),
  createUnit: (
    s: SelectionRef & {
      type: UnitType;
      content?: string;
      note?: string | null;
      origin?: "manual" | "distill";
      candidateAction?: "accept" | "edit";
    },
  ) => req<CreateUnitResponse>("POST", "/api/units", s),
  updateUnit: (id: number, p: { content?: string; note?: string | null }) => req<UnitDto>("PATCH", `/api/units/${id}`, p),
  deleteUnit: (id: number) => req<{ ok: true }>("DELETE", `/api/units/${id}`),
  link: (fromId: number, toId: number, relation: Relation) => req<{ id: number }>("POST", "/api/unit-links", { fromId, toId, relation }),
  unlink: (id: number) => req<{ ok: true }>("DELETE", `/api/unit-links/${id}`),

  distill: (s: SelectionRef) => req<DistillResponse>("POST", "/api/distill", s),
  dismissCandidate: (unitType: string, docId: number) => req<{ ok: true }>("POST", "/api/candidate-events", { unitType, docId }),

  settings: () => req<SettingsDto>("GET", "/api/settings"),
  saveSettings: (ai: { baseUrl?: string; model?: string; apiKey?: string }) => req<SettingsDto>("PUT", "/api/settings", { ai }),
  exportNow: () => req<{ dir: string; files: string[] }>("POST", "/api/export"),
};
