import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Candidate, DocumentDto, HighlightDto, PageDto, ReadingStatus, StatusDto, UnitDto, UnitType } from "../../../shared/types";
import { MAX_SPAN_PAGES, READING_STATUSES, pagesLabel } from "../../../shared/types";
import { compactWithMap } from "../../../shared/compact";
import { api } from "../api";
import { CopyCitation, Empty, ErrorState, Loading, READING_LABEL, SuggestionBar, TYPE_LABEL, TypeBadge, useToast, type Suggestion } from "../components";
import { href, type Route } from "../router";
import { PdfPage, TextPage, usePdf, type Mark, type PageHandle, type Registry } from "../reader/pages";
import { compactOffsetOfRange } from "../reader/locate";

interface Flash {
  page: number;
  text: string;
  start: number;
  /** set when the span ends on a later page */
  endPage?: number;
  end?: number;
}

interface TocEntry {
  title: string;
  page: number;
  depth: number;
}

interface Bar {
  page: number;
  text: string;
  hint?: number;
  /** last page and the text selected on it, when the selection crosses pages */
  endPage?: number;
  endText?: string;
  x: number;
  y: number;
}

interface ComposerState {
  page: number;
  text: string;
  hint?: number;
  endPage?: number;
  endText?: string;
  type: Exclude<UnitType, "quote">;
  content: string;
  note: string;
}

interface DistillCandidate extends Candidate {
  id: number;
  edited: string;
}

interface DistillState {
  loading: boolean;
  page: number;
  /** what to send back when accepting: the exact span for one page, the original parts for several */
  anchorText: string;
  hint?: number;
  endPage?: number;
  endText?: string;
  /** the exact source text, for display */
  shownText: string;
  candidates: DistillCandidate[];
  dropped: number;
  /** how many verified candidates were offered in total (candidates shrinks as you decide) */
  proposed: number;
  error: string | null;
}

export function ReaderPage({ route, status }: { route: Route; status: StatusDto | null }) {
  const docId = Number(route.path[1]);
  const toast = useToast();

  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const [pages, setPages] = useState<PageDto[]>([]);
  const [highlights, setHighlights] = useState<HighlightDto[]>([]);
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(900);
  const [est1, setEst1] = useState<{ w: number; h: number } | null>(null);
  const [curPage, setCurPage] = useState(1);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [tab, setTab] = useState<"knowledge" | "highlights">("knowledge");
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [distill, setDistill] = useState<DistillState | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [find, setFind] = useState("");

  const scroller = useRef<HTMLDivElement>(null);
  const registry = useRef<Registry>(new Map());
  const handledRoute = useRef<string>("");
  const lastFind = useRef<{ q: string; page: number } | null>(null);

  const register = useCallback((n: number, h: PageHandle | null) => {
    if (h) registry.current.set(n, h);
    else registry.current.delete(n);
  }, []);

  const reloadKnowledge = useCallback(async () => {
    const [h, u] = await Promise.all([api.highlights(docId), api.units({ docId })]);
    setHighlights(h);
    setUnits(u);
  }, [docId]);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setPages([]);
    setLoadError(null);
    (async () => {
      try {
        const [d, p, h, u] = await Promise.all([api.document(docId), api.pages(docId), api.highlights(docId), api.units({ docId })]);
        if (!alive) return;
        setDoc(d);
        setPages(p);
        setHighlights(h);
        setUnits(u);
        if (d.readingStatus === "unread" && d.processingStatus !== "failed") {
          api.patchDocument(docId, { readingStatus: "reading" }).then((nd) => alive && setDoc(nd)).catch(() => undefined);
        }
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  // While scanned pages are being read, pick up each page as it becomes searchable text.
  const ocrPending = doc?.ocrPending ?? 0;
  useEffect(() => {
    if (ocrPending <= 0) return;
    let alive = true;
    const t = setInterval(() => {
      Promise.all([api.document(docId), api.pages(docId)])
        .then(([d, p]) => {
          if (!alive) return;
          setDoc(d);
          setPages(p);
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ocrPending, docId]);

  const isPdf = doc?.kind === "pdf";
  const { pdf, error: pdfError } = usePdf(isPdf ? `/api/documents/${docId}/file` : null);

  // ---------- table of contents: the PDF's own outline, or the headings of a Markdown file ----------
  const [pdfToc, setPdfToc] = useState<TocEntry[]>([]);
  useEffect(() => {
    setPdfToc([]);
    if (!pdf) return;
    let alive = true;
    (async () => {
      const outline = (await pdf.getOutline().catch(() => null)) ?? [];
      const out: TocEntry[] = [];
      const walk = async (items: typeof outline, depth: number) => {
        for (const it of items) {
          try {
            const dest = typeof it.dest === "string" ? await pdf.getDestination(it.dest) : it.dest;
            const ref = dest?.[0];
            const page = ref == null ? 0 : typeof ref === "number" ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
            if (page) out.push({ title: it.title, page, depth });
          } catch {
            // an entry pointing nowhere is skipped
          }
          if (it.items?.length && depth < 3) await walk(it.items, depth + 1);
        }
      };
      await walk(outline, 0);
      if (alive) setPdfToc(out);
    })();
    return () => {
      alive = false;
    };
  }, [pdf]);
  const toc = useMemo<TocEntry[]>(() => {
    if (doc?.kind === "pdf") return pdfToc;
    if (doc?.kind !== "markdown") return [];
    const out: TocEntry[] = [];
    let inFence = false;
    for (const p of pages) {
      for (const line of p.text.split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        const m = inFence ? null : /^(#{1,4})\s+(.+)$/.exec(line);
        if (m) out.push({ title: m[2].trim(), page: p.page, depth: m[1].length - 1 });
      }
    }
    return out;
  }, [doc?.kind, pdfToc, pages]);

  useEffect(() => {
    if (!pdf) return;
    pdf.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setEst1({ w: v.width, h: v.height });
    });
  }, [pdf]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  const scale = est1 ? (Math.min(width - 48, 920) / est1.w) * zoom : 1;
  const est = est1 ? { w: est1.w * scale, h: est1.h * scale } : { w: 600, h: 800 };

  // Zooming or resizing rescales every page; keep the reader at the same place in the document.
  const lastScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = lastScale.current;
    lastScale.current = scale;
    if (el && prev > 0 && Math.abs(prev - scale) > 0.001 && el.scrollTop > 0) el.scrollTop = (el.scrollTop * scale) / prev;
  }, [scale]);

  // ---------- scrolling / jumping ----------
  const scrollToPage = useCallback((n: number, tries = 0) => {
    const h = registry.current.get(n);
    if (h) h.el.scrollIntoView({ block: "start" });
    else if (tries < 30) setTimeout(() => scrollToPage(n, tries + 1), 100);
  }, []);

  const pageTextOf = useCallback((n: number) => pages.find((p) => p.page === n)?.text ?? "", [pages]);

  const showFlash = useCallback(
    (f: Flash) => {
      setFlash(f);
      scrollToPage(f.page);
    },
    [scrollToPage],
  );

  useEffect(() => {
    if (flash) {
      const t = setTimeout(() => setFlash(null), 6000);
      return () => clearTimeout(t);
    }
  }, [flash]);

  const ready = doc && pages.length > 0 && (!isPdf || (pdf && est1));
  useEffect(() => {
    if (!ready) return;
    const key = `${docId}|${route.params.toString()}`;
    if (handledRoute.current === key) return;
    handledRoute.current = key;
    const pageParam = Number(route.params.get("page"));
    const passage = route.params.get("passage");
    const unit = route.params.get("unit");
    if (passage) {
      api
        .passage(Number(passage))
        .then((p) => showFlash({ page: p.page, text: p.text, start: p.start }))
        .catch(() => pageParam && scrollToPage(pageParam));
    } else if (unit) {
      const u = units.find((x) => x.id === Number(unit));
      if (u) showFlash({ page: u.page, text: u.sourceText, start: u.start, endPage: u.endPage, end: u.end });
      else if (pageParam) scrollToPage(pageParam);
    } else if (pageParam) {
      scrollToPage(pageParam);
    }
  }, [ready, docId, route.params, units, showFlash, scrollToPage]);

  // current page indicator
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      setBar(null);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + 90;
        let cur = 1;
        for (const [n, h] of registry.current) {
          if (h.el.getBoundingClientRect().top <= top && n > cur) cur = n;
        }
        setCurPage(cur);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc]);

  // ---------- marks ----------
  const marksByPage = useMemo(() => {
    const m = new Map<number, Mark[]>();
    const add = (page: number, mark: Mark) => {
      const l = m.get(page) ?? [];
      l.push(mark);
      m.set(page, l);
    };
    // A span over several pages is drawn as one mark per page: the tail of the first, whole pages in
    // between, the head of the last. The text comes from the stored pages, so it matches exactly.
    const addSpan = (span: { page: number; endPage: number; start: number; end: number; text: string }, mark: Omit<Mark, "text" | "start">) => {
      if (span.endPage <= span.page) return add(span.page, { ...mark, text: span.text, start: span.start });
      for (let p = span.page; p <= span.endPage; p++) {
        const full = pageTextOf(p);
        const from = p === span.page ? span.start : 0;
        const to = p === span.endPage ? span.end : full.length;
        const text = full.slice(from, to);
        if (text.trim()) add(p, { ...mark, text, start: from });
      }
    };
    for (const h of highlights) {
      addSpan(h, { key: `h-${h.id}`, className: h.stale ? "hl stale" : "hl", title: h.note ?? undefined });
    }
    for (const u of units) {
      if (u.type !== "quote") addSpan({ ...u, text: u.sourceText }, { key: `u-${u.id}`, className: "unit-mark", title: `${TYPE_LABEL[u.type]}: ${u.content}` });
    }
    if (flash) addSpan({ page: flash.page, endPage: flash.endPage ?? flash.page, start: flash.start, end: flash.end ?? 0, text: flash.text }, { key: "flash", className: "flash" });
    return m;
  }, [highlights, units, flash, pageTextOf]);

  const onMarkClick = useCallback((key: string) => setTab(key.startsWith("u-") ? "knowledge" : "highlights"), []);

  // ---------- selection ----------
  const onSelect = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setBar(null);
    const range = sel.getRangeAt(0);
    const pageOf = (n: Node) => ((n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element))?.closest("[data-page]") as HTMLElement | null) ?? null;
    const a = pageOf(range.startContainer);
    const b = pageOf(range.endContainer);
    if (!a || !b) return setBar(null);
    const page = Number(a.dataset.page);
    const endPage = Number(b.dataset.page);
    const ix = registry.current.get(page)?.index();
    const hint = ix ? compactOffsetOfRange(ix, range) : undefined;
    const r = range.getBoundingClientRect();

    if (a === b) {
      const text = sel.toString().trim();
      if (!text) return setBar(null);
      return setBar({ page, text, hint, x: r.left + r.width / 2, y: r.top });
    }

    // The selection crosses pages. Send the text on its first and last page; the server takes the
    // pages in between whole from the stored text (they may not even be rendered right now).
    if (endPage - page + 1 > MAX_SPAN_PAGES) {
      toast(`A selection can cover at most ${MAX_SPAN_PAGES} pages.`);
      return setBar(null);
    }
    const layerOf = (el: HTMLElement) => (el.querySelector(".textLayer, .text-body") as HTMLElement | null) ?? el;
    const first = range.cloneRange();
    first.setEnd(layerOf(a), layerOf(a).childNodes.length);
    const last = range.cloneRange();
    last.setStart(layerOf(b), 0);
    const text = first.toString().trim();
    const endText = last.toString().trim();
    if (!text || !endText) return setBar(null);
    setBar({ page, text, hint, endPage, endText, x: r.left + r.width / 2, y: r.top });
  }, [toast]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setBar(null);
  };

  const sourceRef = (b: { page: number; text: string; hint?: number; endPage?: number; endText?: string }) => ({
    docId,
    page: b.page,
    selectionText: b.text,
    hint: b.hint,
    ...(b.endPage && b.endPage !== b.page ? { endPage: b.endPage, endText: b.endText } : {}),
  });

  const doHighlight = async () => {
    if (!bar) return;
    try {
      await api.addHighlight(sourceRef(bar));
      await reloadKnowledge();
      setTab("highlights");
    } catch (e) {
      toast((e as Error).message, "error");
    }
    clearSelection();
  };

  const doQuote = async () => {
    if (!bar) return;
    try {
      await api.createUnit({ type: "quote", ...sourceRef(bar) });
      await reloadKnowledge();
      setTab("knowledge");
      toast(`Saved as a quote (${pagesLabel(bar.page, bar.endPage ?? bar.page)}).`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
    clearSelection();
  };

  const doWrite = () => {
    if (!bar) return;
    setComposer({ page: bar.page, text: bar.text, hint: bar.hint, endPage: bar.endPage, endText: bar.endText, type: "idea", content: "", note: "" });
    clearSelection();
  };

  const doDistill = async () => {
    if (!bar) return;
    const b = bar;
    clearSelection();
    setComposer(null);
    const multi = !!b.endPage && b.endPage !== b.page;
    setDistill({ loading: true, page: b.page, anchorText: b.text, shownText: b.text, hint: b.hint, endPage: b.endPage, endText: b.endText, candidates: [], dropped: 0, proposed: 0, error: null });
    try {
      const r = await api.distill(sourceRef(b));
      setDistill({
        loading: false,
        page: b.page,
        // one page: the exact span is the safest thing to send back; several pages: the original parts
        anchorText: multi ? b.text : r.anchor.text,
        shownText: r.anchor.text,
        endPage: b.endPage,
        endText: b.endText,
        hint: b.hint,
        candidates: r.candidates.map((c, i) => ({ ...c, id: i, edited: c.text })),
        dropped: r.dropped,
        proposed: r.candidates.length,
        error: null,
      });
    } catch (e) {
      setDistill({ loading: false, page: b.page, anchorText: b.text, shownText: b.text, hint: b.hint, endPage: b.endPage, endText: b.endText, candidates: [], dropped: 0, proposed: 0, error: (e as Error).message });
    }
  };

  const afterCreate = async (r: { unit: UnitDto; suggestion: { unit: UnitDto; similarity: number } | null }) => {
    await reloadKnowledge();
    setTab("knowledge");
    if (r.suggestion) setSuggestion({ created: r.unit, other: r.suggestion.unit, similarity: r.suggestion.similarity });
  };

  const saveComposer = async () => {
    if (!composer) return;
    try {
      const r = await api.createUnit({
        type: composer.type,
        content: composer.content,
        note: composer.note || null,
        ...sourceRef({ page: composer.page, text: composer.text, hint: composer.hint, endPage: composer.endPage, endText: composer.endText }),
      });
      setComposer(null);
      toast(`${TYPE_LABEL[composer.type]} saved, linked to ${pagesLabel(composer.page, composer.endPage ?? composer.page)}.`);
      await afterCreate(r);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const acceptCandidate = async (c: DistillCandidate) => {
    if (!distill) return;
    const edited = c.edited.trim() !== c.text;
    try {
      const r = await api.createUnit({
        type: c.type,
        content: c.edited,
        ...sourceRef({ page: distill.page, text: distill.anchorText, hint: distill.hint, endPage: distill.endPage, endText: distill.endText }),
        origin: "distill",
        candidateAction: edited ? "edit" : "accept",
      });
      setDistill((d) => d && { ...d, candidates: d.candidates.filter((x) => x.id !== c.id) });
      toast(`${TYPE_LABEL[c.type]} saved.`);
      await afterCreate(r);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const dismissCandidate = async (c: DistillCandidate) => {
    api.dismissCandidate(c.type, docId).catch(() => undefined);
    setDistill((d) => d && { ...d, candidates: d.candidates.filter((x) => x.id !== c.id) });
  };

  const closeDistill = () => {
    distill?.candidates.forEach((c) => api.dismissCandidate(c.type, docId).catch(() => undefined));
    setDistill(null);
  };

  // ---------- find in document ----------
  const doFind = (e: React.FormEvent) => {
    e.preventDefault();
    const q = compactWithMap(find).compact;
    if (!q) return;
    const startFrom = lastFind.current?.q === find ? lastFind.current.page + 1 : curPage;
    const order = [...pages.filter((p) => p.page >= startFrom), ...pages.filter((p) => p.page < startFrom)];
    for (const p of order) {
      const c = compactWithMap(p.text);
      const i = c.compact.indexOf(q);
      if (i >= 0) {
        const s = c.map[i];
        const eIdx = c.map[i + q.length - 1] + 1;
        lastFind.current = { q: find, page: p.page };
        showFlash({ page: p.page, text: p.text.slice(s, eIdx), start: s });
        return;
      }
    }
    toast("Not found in this document.");
  };

  const setReading = async (s: ReadingStatus) => {
    try {
      setDoc(await api.patchDocument(docId, { readingStatus: s }));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  // ---------- render ----------
  if (loadError)
    return (
      <div className="page narrow">
        <ErrorState message={loadError}>
          <a className="btn" href={href("")}>
            Back to the library
          </a>
        </ErrorState>
      </div>
    );
  if (!doc)
    return (
      <div className="page narrow">
        <Loading label="Opening the document…" rows={2} />
      </div>
    );

  const failed = doc.processingStatus === "failed";
  const barLeft = bar ? Math.max(8, Math.min(window.innerWidth - 400, bar.x - 190)) : 0;
  const barTop = bar ? Math.max(60, bar.y - 52) : 0;

  return (
    <div className="reader">
      <div className="reader-head" role="toolbar" aria-label="Reader">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href={href("")}>Library</a>
          <span aria-hidden="true">/</span>
          <strong className="reader-title" title={doc.title}>
            {doc.title}
          </strong>
        </nav>
        <span className="muted small page-count" aria-live="polite">
          p. {curPage} / {doc.pageCount}
        </span>
        <form onSubmit={doFind} className="row" role="search">
          <input className="find" type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in document" aria-label="Find in document" />
        </form>
        {isPdf && (
          <span className="row">
            <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">
              −
            </button>
            <span className="small">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">
              +
            </button>
          </span>
        )}
        {toc.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n) scrollToPage(n);
            }}
            aria-label="Contents"
          >
            <option value="">Contents</option>
            {toc.map((t, i) => (
              <option key={i} value={t.page}>
                {"\u00A0\u00A0".repeat(t.depth)}
                {t.title} ({t.page})
              </option>
            ))}
          </select>
        )}
        <select value={doc.readingStatus} onChange={(e) => void setReading(e.target.value as ReadingStatus)} aria-label="Reading status">
          {READING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {READING_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="reader-body">
        <div className="reader-scroll" ref={scroller} onMouseUp={() => setTimeout(onSelect, 0)} onKeyUp={() => setTimeout(onSelect, 0)}>
          {!failed && doc.failureNotes.map((n, i) => <div key={i} className="note warn banner">{n}</div>)}
          {failed && (
            <div className="note bad banner">
              {doc.failureNotes.join(" ") || "This document has no readable text."} You can still open the original file, but it cannot be searched or highlighted here.{" "}
              <a href={`/api/documents/${docId}/file`} target="_blank" rel="noreferrer">
                Open the original file
              </a>
            </div>
          )}
          {doc.processingStatus === "processing" && doc.ocrPending === 0 && <div className="note banner">Still processing this document…</div>}
          {pdfError && <div className="note bad banner" role="alert">Could not display the PDF: {pdfError}</div>}
          {!failed && isPdf && !pdf && !pdfError && (
            <div className="note banner" role="status">
              Loading pages…
            </div>
          )}

          {!failed && isPdf && pdf &&
            Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
              <PdfPage
                key={n}
                pdf={pdf}
                num={n}
                scale={scale}
                est={est}
                pageText={pageTextOf(n)}
                marks={marksByPage.get(n) ?? EMPTY}
                register={register}
                onMarkClick={onMarkClick}
                ocr={pages.find((p) => p.page === n)?.ocr}
                loadOcrWords={() => api.ocrWords(docId, n)}
              />
            ))}

          {!failed && !isPdf &&
            pages.map((p) => (
              <TextPage key={p.page} num={p.page} pageText={p.text} marks={marksByPage.get(p.page) ?? EMPTY} register={register} onMarkClick={onMarkClick} />
            ))}
        </div>

        <aside className="reader-side">
          {suggestion && <SuggestionBar s={suggestion} onDone={() => setSuggestion(null)} />}

          {distill && (
            <section className="panel">
              <div className="row between">
                <strong>Distill</strong>
                <button className="link" onClick={closeDistill}>
                  Close
                </button>
              </div>
              <blockquote className="origin">{distill.shownText}</blockquote>
              {distill.loading && <p className="muted">Reading the passage…</p>}
              {distill.error && (
                <div className="note bad">
                  {distill.error} <a href={href("settings")}>Open Settings</a>
                </div>
              )}
              {!distill.loading && !distill.error && distill.candidates.length === 0 && distill.proposed > 0 && (
                <p className="muted small">That's all the suggestions. Close this when you're done.</p>
              )}
              {!distill.loading && !distill.error && distill.candidates.length === 0 && distill.proposed === 0 && (
                <p className="muted small">
                  Nothing worth proposing here{distill.dropped ? ` (${distill.dropped} suggestion${distill.dropped > 1 ? "s" : ""} discarded because they were not backed by the text)` : ""}. You can still write your own.
                </p>
              )}
              {distill.candidates.map((c) => (
                <div key={c.id} className="candidate">
                  <TypeBadge type={c.type} />
                  <textarea value={c.edited} rows={3} onChange={(e) => setDistill((d) => d && { ...d, candidates: d.candidates.map((x) => (x.id === c.id ? { ...x, edited: e.target.value } : x)) })} />
                  <div className="evidence" title="Verbatim from the source">
                    Evidence: “{c.supportingQuote}”
                  </div>
                  <div className="row">
                    <button className="primary" disabled={!c.edited.trim()} onClick={() => void acceptCandidate(c)}>
                      {c.edited.trim() !== c.text ? "Accept edited" : "Accept"}
                    </button>
                    <button onClick={() => void dismissCandidate(c)}>Dismiss</button>
                  </div>
                </div>
              ))}
              {distill.proposed > 0 && distill.dropped > 0 && (
                <p className="muted small">
                  {distill.dropped} more suggestion{distill.dropped > 1 ? "s were" : " was"} discarded because {distill.dropped > 1 ? "their evidence was" : "its evidence was"} not in the text.
                </p>
              )}
              {distill.candidates.length > 0 && <p className="muted small">Candidates are only suggestions. Nothing is kept until you accept it, and unaccepted ones disappear when you close this.</p>}
            </section>
          )}

          {composer && (
            <section className="panel">
              <div className="row between">
                <strong>In your own words</strong>
                <button className="link" onClick={() => setComposer(null)}>
                  Cancel
                </button>
              </div>
              <blockquote className="origin">
                {composer.text}
                {composer.endPage && composer.endPage !== composer.page && (
                  <>
                    <span className="muted small"> [page {composer.page} / {composer.endPage}] </span>
                    {composer.endText}
                  </>
                )}
              </blockquote>
              <div className="row">
                {(["idea", "concept", "question"] as const).map((t) => (
                  <label key={t} className="radio">
                    <input type="radio" checked={composer.type === t} onChange={() => setComposer({ ...composer, type: t })} /> {TYPE_LABEL[t]}
                  </label>
                ))}
              </div>
              <textarea autoFocus rows={4} placeholder="What do you want to remember?" value={composer.content} onChange={(e) => setComposer({ ...composer, content: e.target.value })} />
              <input placeholder="Note (optional)" value={composer.note} onChange={(e) => setComposer({ ...composer, note: e.target.value })} />
              <button className="primary" disabled={!composer.content.trim()} onClick={() => void saveComposer()}>
                Save, linked to {pagesLabel(composer.page, composer.endPage ?? composer.page)}
              </button>
            </section>
          )}

          <div className="tabs">
            <button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>
              Knowledge ({units.length})
            </button>
            <button className={tab === "highlights" ? "active" : ""} onClick={() => setTab("highlights")}>
              Highlights ({highlights.length})
            </button>
          </div>

          {tab === "knowledge" && (
            <div className="sidelist">
              {units.length === 0 && <p className="muted small">Select text in the page, then keep a quote, write an idea, or Distill. Everything you keep stays linked to its exact source.</p>}
              {units.map((u) => (
                <div key={u.id} className="side-item">
                  <div className="row between">
                    <TypeBadge type={u.type} />
                    <button className="link small" onClick={() => showFlash({ page: u.page, text: u.sourceText, start: u.start, endPage: u.endPage, end: u.end })}>
                      {pagesLabel(u.page, u.endPage)}
                    </button>
                  </div>
                  <div className="content small">{u.content}</div>
                  <div className="row">
                    <a className="small" href={href(`knowledge/${u.id}`)}>
                      Details
                    </a>
                    <CopyCitation unit={u} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "highlights" && (
            <div className="sidelist">
              {highlights.length === 0 && <p className="muted small">No highlights yet.</p>}
              {highlights.map((h) => (
                <div key={h.id} className="side-item">
                  <div className="row between">
                    <button className="link small" onClick={() => showFlash({ page: h.page, text: h.text, start: h.start, endPage: h.endPage, end: h.end })}>
                      {pagesLabel(h.page, h.endPage)}
                    </button>
                    <button
                      className="link danger small"
                      onClick={async () => {
                        await api.deleteHighlight(h.id).catch((e) => toast((e as Error).message, "error"));
                        await reloadKnowledge();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="content small">{h.text.length > 200 ? h.text.slice(0, 200) + "…" : h.text}</div>
                  {h.stale && <div className="note warn small">This highlight could not be re-located after re-reading the file.</div>}
                  <input
                    className="small"
                    placeholder="Add a note"
                    defaultValue={h.note ?? ""}
                    onBlur={async (e) => {
                      if ((e.target.value || null) !== h.note) {
                        await api.updateHighlight(h.id, e.target.value || null).catch((x) => toast((x as Error).message, "error"));
                        await reloadKnowledge();
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {status && !status.ai.configured && <p className="muted small">Distill needs an AI provider. Add one in Settings. Everything else works without it.</p>}
        </aside>
      </div>

      {bar && (
        <div className="selbar" style={{ left: barLeft, top: barTop }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => void doHighlight()}>Highlight</button>
          <button onClick={() => void doQuote()}>Keep as Quote</button>
          <button onClick={() => doWrite()}>Write idea…</button>
          <button className="primary" onClick={() => void doDistill()}>
            Distill
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY: Mark[] = [];
