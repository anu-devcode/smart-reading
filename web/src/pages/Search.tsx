import { useCallback, useEffect, useState } from "react";
import type { PassageHit, SearchResponse, UnitType } from "../../../shared/types";
import { UNIT_TYPES } from "../../../shared/types";
import { api } from "../api";
import { Empty, Snippet, SourceLine, SuggestionBar, TYPE_LABEL, TypeBadge, WhyLine, useToast, type Suggestion } from "../components";
import { go, href, type Route } from "../router";

export function SearchPage({ route }: { route: Route }) {
  const toast = useToast();
  const q = route.params.get("q") ?? "";
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideaFor, setIdeaFor] = useState<number | null>(null);
  const [ideaType, setIdeaType] = useState<Exclude<UnitType, "quote">>("idea");
  const [ideaText, setIdeaText] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const run = useCallback(async () => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRes(await api.search(q));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    void run();
  }, [run]);

  const keepQuote = async (p: PassageHit) => {
    try {
      const r = await api.createUnit({ type: "quote", docId: p.docId, page: p.page, selectionText: p.text });
      toast(`Saved as a quote (${p.docTitle}, p. ${p.page}).`);
      void run();
      return r;
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const saveIdea = async (p: PassageHit) => {
    try {
      const r = await api.createUnit({
        type: ideaType,
        content: ideaText,
        docId: p.docId,
        page: p.page,
        selectionText: p.text,
      });
      toast(`${TYPE_LABEL[ideaType]} saved, linked to ${p.docTitle}, p. ${p.page}.`);
      setIdeaFor(null);
      setIdeaText("");
      if (r.suggestion) setSuggestion({ created: r.unit, other: r.suggestion.unit, similarity: r.suggestion.similarity });
      void run();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const saveCollection = async () => {
    const name = prompt("Name this collection (a saved view of this search)", q);
    if (!name) return;
    try {
      await api.addCollection(name, q);
      toast("Collection saved. Find it in the Library sidebar.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const empty = res && res.passages.length === 0 && res.saved.units.length === 0 && res.files.length === 0;
  const totalSaved = res ? UNIT_TYPES.reduce((n, t) => n + res.saved.counts[t], 0) : 0;

  return (
    <div className="page narrow">
      <form
        className="bigsearch"
        onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("q") as string;
          go("search", { q: v.trim() });
        }}
      >
        <input name="q" key={q} defaultValue={q} placeholder='Try: "scarce resource", forgetting AND intervals, title:complexity, type:idea' autoFocus />
        <button className="primary" type="submit">
          Search
        </button>
      </form>

      <details className="help">
        <summary>Search tips</summary>
        <ul>
          <li>
            <code>attention scarce</code> finds passages with those words; if few, it widens to any of them.
          </li>
          <li>
            <code>"exact phrase"</code>, <code>a AND b</code>, <code>a OR b</code>, <code>a NOT b</code> (operators in capitals), <code>interrupt*</code>
          </li>
          <li>
            <code>title:word</code>, <code>author:name</code>, <code>note:word</code>
          </li>
          <li>
            Filters: <code>type:idea</code> (quote, idea, concept, question), <code>status:unread</code>, <code>kind:pdf</code>
          </li>
          <li>You can also describe an idea in your own words: meaning search finds the passage even when the words differ.</li>
        </ul>
      </details>

      {suggestion && <SuggestionBar s={suggestion} onDone={() => setSuggestion(null)} />}
      {loading && <div className="muted">Searching…</div>}
      {error && <div className="note bad">{error}</div>}
      {!q.trim() && <Empty>Search your sources and everything you've kept. Results always show the passage and the page they came from.</Empty>}

      {res && (
        <>
          <div className="interpreted muted small">
            {res.interpreted.structured ? "Exact search" : res.interpreted.mode === "or" ? "Keyword search widened to any word" : "Keyword search"}
            {res.interpreted.semantic === "used" && " + meaning search"}
            {res.interpreted.semantic === "unavailable" && " · meaning search unavailable right now"}
            {Object.entries(res.interpreted.filters).map(([k, v]) => (
              <span key={k} className="chip">
                {k}: {v}
              </span>
            ))}
            <button className="link" onClick={saveCollection}>
              Save as collection
            </button>
          </div>

          {empty && <Empty>No results. Try fewer words, or describe the idea differently.</Empty>}

          {totalSaved > 0 && (
            <section>
              <h2>What you've saved</h2>
              <div className="countrow">
                {UNIT_TYPES.filter((t) => res.saved.counts[t] > 0).map((t) => (
                  <span key={t} className={`badge type-${t}`}>
                    {res.saved.counts[t]} {TYPE_LABEL[t].toLowerCase()}
                    {res.saved.counts[t] > 1 ? "s" : ""}
                  </span>
                ))}
              </div>
              {res.saved.units.map((h) => (
                <article key={h.unit.id} className="card">
                  <div className="row">
                    <TypeBadge type={h.unit.type} />
                    <SourceLine unit={h.unit} />
                  </div>
                  <p className="content">
                    <Snippet text={h.unit.type === "quote" ? h.snippet : h.snippet || h.unit.content} />
                  </p>
                  {h.unit.type !== "quote" && <blockquote className="origin">{h.unit.sourceText}</blockquote>}
                  <WhyLine why={h.why} />
                  <div className="row actions">
                    <a className="btn" href={href(`reader/${h.unit.docId}`, { page: h.unit.page, unit: h.unit.id })}>
                      Open source
                    </a>
                    <a className="btn" href={href(`knowledge/${h.unit.id}`)}>
                      Details
                    </a>
                  </div>
                </article>
              ))}
            </section>
          )}

          {res.passages.length > 0 && (
            <section>
              <h2>Passages</h2>
              {res.passages.map((p) => (
                <article key={p.passageId} className="card">
                  <div className="row between">
                    <span className="source">
                      {p.docTitle}, p. {p.page}
                    </span>
                  </div>
                  <p className="content">
                    <Snippet text={p.snippet} />
                  </p>
                  <WhyLine why={p.why} />
                  <div className="row actions">
                    <a className="btn" href={href(`reader/${p.docId}`, { page: p.page, passage: p.passageId })}>
                      Open source
                    </a>
                    <button onClick={() => void keepQuote(p)}>Keep as Quote</button>
                    <button
                      onClick={() => {
                        setIdeaFor(ideaFor === p.passageId ? null : p.passageId);
                        setIdeaText("");
                      }}
                    >
                      Create idea…
                    </button>
                  </div>
                  {ideaFor === p.passageId && (
                    <div className="composer">
                      <div className="row">
                        {(["idea", "concept", "question"] as const).map((t) => (
                          <label key={t} className="radio">
                            <input type="radio" checked={ideaType === t} onChange={() => setIdeaType(t)} /> {TYPE_LABEL[t]}
                          </label>
                        ))}
                      </div>
                      <textarea
                        autoFocus
                        placeholder="In your own words…"
                        value={ideaText}
                        onChange={(e) => setIdeaText(e.target.value)}
                        rows={3}
                      />
                      <div className="row">
                        <button className="primary" disabled={!ideaText.trim()} onClick={() => void saveIdea(p)}>
                          Save, linked to this passage
                        </button>
                        <button onClick={() => setIdeaFor(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}

          {res.files.length > 0 && (
            <section>
              <h2>Files</h2>
              {res.files.map((f) => (
                <article key={f.docId} className="card slim row between">
                  <div>
                    <a className="doc-title" href={href(`reader/${f.docId}`)}>
                      {f.title}
                    </a>
                    <div className="muted small">
                      {[f.author, f.kind.toUpperCase(), f.titleMatch ? "title match" : null, f.passageHits ? `${f.passageHits} matching passage${f.passageHits > 1 ? "s" : ""}` : null, f.unitCount ? `${f.unitCount} saved` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <a className="btn" href={href(`reader/${f.docId}`)}>
                    Open
                  </a>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
