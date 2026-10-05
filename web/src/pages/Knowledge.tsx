import { useCallback, useEffect, useState } from "react";
import type { DocumentDto, Relation, UnitContextDto, UnitDto, UnitType } from "../../../shared/types";
import { RELATIONS, UNIT_TYPES } from "../../../shared/types";
import { api } from "../api";
import { Empty, SourceLine, TYPE_LABEL, TypeBadge, useToast } from "../components";
import { go, href, type Route } from "../router";

const RELATION_LABEL: Record<Relation, string> = {
  same_idea: "Same idea",
  supports: "Supports",
  contradicts: "Contradicts",
};

export function KnowledgePage({ route }: { route: Route }) {
  const id = route.path[1] ? Number(route.path[1]) : null;
  return id ? <UnitDetail id={id} /> : <UnitList route={route} />;
}

function UnitList({ route }: { route: Route }) {
  const toast = useToast();
  const docId = route.params.get("docId") ? Number(route.params.get("docId")) : undefined;
  const type = (route.params.get("type") as UnitType | null) ?? undefined;
  const [units, setUnits] = useState<UnitDto[] | null>(null);
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.units({ type, docId }).then(setUnits).catch((e) => toast((e as Error).message, "error"));
    if (docId) api.document(docId).then(setDoc).catch(() => undefined);
    else setDoc(null);
  }, [type, docId, toast]);

  const shown = (units ?? []).filter((u) => !filter.trim() || `${u.content} ${u.note ?? ""} ${u.sourceText}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page narrow">
      <h2>Knowledge you've kept</h2>
      <p className="muted">Everything here was accepted by you and stays linked to its exact source.</p>
      {doc && (
        <div className="chip">
          From: {doc.title}{" "}
          <a href={href("knowledge", { type })} title="Show all">
            ×
          </a>
        </div>
      )}
      <div className="row" style={{ margin: "12px 0" }}>
        <a className={`btn ${!type ? "active" : ""}`} href={href("knowledge", { docId })}>
          All
        </a>
        {UNIT_TYPES.map((t) => (
          <a key={t} className={`btn ${type === t ? "active" : ""}`} href={href("knowledge", { type: t, docId })}>
            {TYPE_LABEL[t]}s
          </a>
        ))}
        <input className="filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {units === null && <Empty>Loading…</Empty>}
      {units && shown.length === 0 && <Empty>Nothing here yet. Open a document, select a passage, and keep a quote or write an idea.</Empty>}
      {shown.map((u) => (
        <article key={u.id} className="card">
          <div className="row between">
            <span className="row">
              <TypeBadge type={u.type} />
              <SourceLine unit={u} />
            </span>
            <span className="muted small">{new Date(u.acceptedAt).toLocaleDateString()}</span>
          </div>
          <p className="content">{u.content}</p>
          {u.type !== "quote" && <blockquote className="origin">{u.sourceText}</blockquote>}
          {u.note && <p className="muted small">Note: {u.note}</p>}
          <div className="row actions">
            <a className="btn" href={href(`knowledge/${u.id}`)}>
              Details
            </a>
            <a className="btn" href={href(`reader/${u.docId}`, { page: u.page, unit: u.id })}>
              Open source
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}

function UnitDetail({ id }: { id: number }) {
  const toast = useToast();
  const [ctx, setCtx] = useState<UnitContextDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [linkQuery, setLinkQuery] = useState("");
  const [candidates, setCandidates] = useState<UnitDto[]>([]);
  const [relation, setRelation] = useState<Relation>("supports");

  const load = useCallback(async () => {
    try {
      const c = await api.unit(id);
      setCtx(c);
      setContent(c.unit.content);
      setNote(c.unit.note ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const findCandidates = async () => {
    if (!linkQuery.trim()) return;
    try {
      const r = await api.search(`${linkQuery} `);
      setCandidates(r.saved.units.map((h) => h.unit).filter((u) => u.id !== id));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  if (error) return <div className="page narrow"><div className="note bad">{error}</div><a href={href("knowledge")}>Back</a></div>;
  if (!ctx) return <div className="page"><Empty>Loading…</Empty></div>;
  const u = ctx.unit;
  const before = ctx.paragraph.slice(0, Math.max(0, u.start - ctx.paragraphStart));
  const after = ctx.paragraph.slice(Math.max(0, u.end - ctx.paragraphStart));

  const save = async () => {
    try {
      await api.updateUnit(id, { content: u.type === "quote" ? undefined : content, note });
      toast("Saved.");
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page narrow">
      <p>
        <a href={href("knowledge")}>← All knowledge</a>
      </p>
      <article className="card">
        <div className="row">
          <TypeBadge type={u.type} />
          <SourceLine unit={u} />
          {u.origin === "distill" && <span className="chip">proposed by AI, accepted by you{u.edited ? " (edited)" : ""}</span>}
        </div>
        {u.type === "quote" ? (
          <p className="content">{u.content}</p>
        ) : (
          <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} aria-label="Your wording" />
        )}
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row actions">
          <button className="primary" onClick={() => void save()} disabled={u.type !== "quote" && !content.trim()}>
            Save changes
          </button>
          <a className="btn" href={href(`reader/${u.docId}`, { page: u.page, unit: u.id })}>
            Open in reader
          </a>
          <a className="btn" href={href("search", { q: u.content })}>
            Find related
          </a>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm("Delete this item from your knowledge? The source document is not affected.")) return;
              await api.deleteUnit(id).catch((e) => toast((e as Error).message, "error"));
              go("knowledge");
            }}
          >
            Delete
          </button>
        </div>
      </article>

      <section>
        <h3>Source</h3>
        <p className="muted small">
          {u.docTitle}, page {u.page}. {u.type === "quote" ? "Author's exact words." : "The passage you were reading."}
        </p>
        <div className="paragraph">
          {before}
          <mark>{u.sourceText}</mark>
          {after}
        </div>
      </section>

      <section>
        <h3>Connections</h3>
        {ctx.links.length === 0 && <p className="muted small">No connections yet. Connections are made only by you.</p>}
        {ctx.links.map((l) => (
          <div key={l.id} className="card slim row between">
            <div>
              <span className="chip">
                {RELATION_LABEL[l.relation]}
                {l.relation !== "same_idea" && (l.direction === "out" ? " →" : " ←")}
              </span>{" "}
              <TypeBadge type={l.other.type} /> <a href={href(`knowledge/${l.other.id}`)}>{l.other.content}</a>
              <div className="muted small">
                {l.other.docTitle}, p. {l.other.page}
              </div>
            </div>
            <button
              className="link danger"
              onClick={async () => {
                await api.unlink(l.id).catch((e) => toast((e as Error).message, "error"));
                await load();
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="composer">
          <div className="row">
            <input placeholder="Find another saved item to connect…" value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void findCandidates()} />
            <select value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
              {RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABEL[r]}
                </option>
              ))}
            </select>
            <button onClick={() => void findCandidates()}>Search</button>
          </div>
          {candidates.map((c) => (
            <div key={c.id} className="row between side-item">
              <span>
                <TypeBadge type={c.type} /> {c.content}
              </span>
              <button
                onClick={async () => {
                  try {
                    await api.link(id, c.id, relation);
                    setCandidates([]);
                    setLinkQuery("");
                    await load();
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
              >
                Connect
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
