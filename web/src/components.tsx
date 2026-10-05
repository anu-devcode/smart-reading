import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { DocumentDto, UnitDto, UnitType, Why } from "../../shared/types";
import { api } from "./api";
import { href } from "./router";

// ---------- toasts ----------

type ToastKind = "info" | "error";
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, kind }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- small display pieces ----------

export const TYPE_LABEL: Record<UnitType, string> = {
  quote: "Quote",
  idea: "Idea",
  concept: "Concept",
  question: "Question",
};

export function TypeBadge({ type }: { type: UnitType }) {
  return <span className={`badge type-${type}`}>{TYPE_LABEL[type]}</span>;
}

const PROCESSING_LABEL: Record<DocumentDto["processingStatus"], string> = {
  processing: "Processing",
  ready: "Ready",
  partial: "Partial",
  failed: "Failed",
};

export function ProcessingChip({ status }: { status: DocumentDto["processingStatus"] }) {
  return <span className={`chip proc-${status}`}>{PROCESSING_LABEL[status]}</span>;
}

/** Renders a snippet where matched terms are wrapped in \u0001 ... \u0002. */
export function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\u0001([^\u0002]*)\u0002/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={i++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function WhyLine({ why }: { why: Why }) {
  const bits: string[] = [];
  if (why.exactPhrase) bits.push("exact phrase");
  else if (why.lexical) bits.push(why.terms.length ? `keywords: ${why.terms.join(", ")}` : "keyword match");
  if (why.semantic !== null) bits.push(`similar meaning (${why.semantic.toFixed(2)})`);
  if (why.titleMatch) bits.push("title match");
  return <div className="why">Why it matched: {bits.join(" + ") || "match"}</div>;
}

export function SourceLine({ unit }: { unit: UnitDto }) {
  return (
    <span className="source">
      {unit.docTitle}, p. {unit.page}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ---------- same-idea suggestion (offered once, at save time) ----------

export interface Suggestion {
  created: UnitDto;
  other: UnitDto;
  similarity: number;
}

export function SuggestionBar({ s, onDone }: { s: Suggestion; onDone: () => void }) {
  const toast = useToast();
  const connect = async () => {
    try {
      await api.link(s.created.id, s.other.id, "same_idea");
      toast("Connected as the same idea.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
    onDone();
  };
  return (
    <div className="suggestion">
      <div>
        <strong>Similar to something you saved earlier</strong> ({Math.round(s.similarity * 100)}% alike)
        <div className="suggestion-text">
          <TypeBadge type={s.other.type} /> {s.other.content}{" "}
          <a href={href(`knowledge/${s.other.id}`)} className="muted">
            ({s.other.docTitle}, p. {s.other.page})
          </a>
        </div>
      </div>
      <div className="row">
        <button className="primary" onClick={connect}>
          Connect as same idea
        </button>
        <button onClick={onDone}>Ignore</button>
      </div>
    </div>
  );
}
