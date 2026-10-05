import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { compactOf } from "../../../shared/compact";
import { buildTextIndex, locateRange, rectsRelativeTo, type TextIndex } from "./locate";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface Mark {
  key: string;
  /** exact text of the span (from the server's page text) */
  text: string;
  /** offset of the span in the server's page text, used to choose between repeats */
  start: number;
  className: string;
  title?: string;
}

export interface PageHandle {
  el: HTMLElement;
  index: () => TextIndex | null;
}

export type Registry = Map<number, PageHandle>;

interface CommonProps {
  num: number;
  pageText: string;
  marks: Mark[];
  register: (num: number, h: PageHandle | null) => void;
  onMarkClick?: (key: string) => void;
}

interface Placed {
  key: string;
  className: string;
  title?: string;
  rects: { x: number; y: number; w: number; h: number }[];
}

function hintFor(pageText: string, start: number): number {
  return compactOf(pageText.slice(0, start)).length;
}

/** Compute overlay rectangles for marks inside a text layer. Re-run whenever the layer or marks change. */
function usePlacedMarks(
  ready: boolean,
  textRoot: React.RefObject<HTMLElement | null>,
  container: React.RefObject<HTMLElement | null>,
  pageText: string,
  marks: Mark[],
  dep: unknown,
): Placed[] {
  const [placed, setPlaced] = useState<Placed[]>([]);
  useLayoutEffect(() => {
    if (!ready || !textRoot.current || !container.current) {
      setPlaced([]);
      return;
    }
    const compute = () => {
      if (!textRoot.current || !container.current) return;
      const ix = buildTextIndex(textRoot.current);
      const out: Placed[] = [];
      for (const m of marks) {
        const range = locateRange(ix, m.text, hintFor(pageText, m.start));
        if (!range) continue;
        const rects = rectsRelativeTo(range, container.current);
        if (rects.length) out.push({ key: m.key, className: m.className, title: m.title, rects });
      }
      setPlaced(out);
    };
    compute();
  }, [ready, marks, pageText, dep, textRoot, container]);
  return placed;
}

function Overlay({ placed, onMarkClick }: { placed: Placed[]; onMarkClick?: (key: string) => void }) {
  return (
    <div className="mark-layer">
      {placed.map((p) =>
        p.rects.map((r, i) => (
          <div
            key={`${p.key}-${i}`}
            className={`mark ${p.className}`}
            title={p.title}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            onClick={() => onMarkClick?.(p.key)}
          />
        )),
      )}
    </div>
  );
}

// ---------------- PDF page ----------------

export function PdfPage({
  pdf,
  scale,
  est,
  ...c
}: CommonProps & { pdf: PDFDocumentProxy; scale: number; est: { w: number; h: number } }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textDiv = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    setSize(null); // scale changed: forget the old size
  }, [scale]);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: { cancel: () => void } | null = null;

    const cleanup = () => {
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      if (textDiv.current) textDiv.current.replaceChildren();
      setReady(false);
    };

    if (!visible) {
      cleanup();
      return;
    }

    (async () => {
      const page = await pdf.getPage(c.num);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      setSize({ w: viewport.width, h: viewport.height });
      const dpr = window.devicePixelRatio || 1;
      const cv = canvas.current!;
      cv.width = Math.floor(viewport.width * dpr);
      cv.height = Math.floor(viewport.height * dpr);
      cv.style.width = `${viewport.width}px`;
      cv.style.height = `${viewport.height}px`;
      const ctx2d = cv.getContext("2d")!;
      task = page.render({
        canvasContext: ctx2d,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      } as never) as unknown as typeof task;
      const td = textDiv.current!;
      td.replaceChildren();
      td.style.width = `${viewport.width}px`;
      td.style.height = `${viewport.height}px`;
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: td,
        viewport,
      });
      textLayer = tl;
      try {
        await Promise.all([task!.promise, tl.render()]);
      } catch (e) {
        if ((e as { name?: string }).name === "RenderingCancelledException") return;
        if (!cancelled) console.warn("page render failed", c.num, e);
        return;
      }
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [visible, pdf, c.num, scale]);

  // handle for the reader (selection hints, scrolling)
  useEffect(() => {
    if (!wrap.current) return;
    c.register(c.num, { el: wrap.current, index: () => (textDiv.current ? buildTextIndex(textDiv.current) : null) });
    return () => c.register(c.num, null);
  }, [c.num]); // eslint-disable-line react-hooks/exhaustive-deps

  const placed = usePlacedMarks(ready, textDiv, wrap, c.pageText, c.marks, scale);
  const w = size?.w ?? est.w;
  const h = size?.h ?? est.h;
  return (
    <div
      ref={wrap}
      className="pdf-page"
      data-page={c.num}
      style={{ width: w, height: h, ["--total-scale-factor" as string]: scale, ["--scale-factor" as string]: scale }}
    >
      <canvas ref={canvas} />
      <div ref={textDiv} className="textLayer" />
      <Overlay placed={placed} onMarkClick={c.onMarkClick} />
      {!ready && <div className="page-placeholder">Page {c.num}</div>}
    </div>
  );
}

// ---------------- plain text / markdown page ----------------

export function TextPage(c: CommonProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (!wrap.current) return;
    c.register(c.num, { el: wrap.current, index: () => (body.current ? buildTextIndex(body.current) : null) });
    return () => c.register(c.num, null);
  }, [c.num]); // eslint-disable-line react-hooks/exhaustive-deps

  const placed = usePlacedMarks(ready, body, wrap, c.pageText, c.marks, 0);
  return (
    <div ref={wrap} className="text-page" data-page={c.num}>
      <div className="text-page-no">Page {c.num}</div>
      <div ref={body} className="text-body">
        {c.pageText}
      </div>
      <Overlay placed={placed} onMarkClick={c.onMarkClick} />
    </div>
  );
}

export function usePdf(url: string | null) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      const doc = await pdfjsLib.getDocument({ url }).promise;
      setPdf(doc);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { pdf, error };
}
