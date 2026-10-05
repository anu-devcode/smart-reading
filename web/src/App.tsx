import { useEffect, useState } from "react";
import type { StatusDto } from "../../shared/types";
import { api } from "./api";
import { ToastProvider } from "./components";
import { go, href, useRoute } from "./router";
import { LibraryPage } from "./pages/Library";
import { SearchPage } from "./pages/Search";
import { ReaderPage } from "./pages/Reader";
import { KnowledgePage } from "./pages/Knowledge";
import { SettingsPage } from "./pages/Settings";

function useStatus(): StatusDto | null {
  const [status, setStatus] = useState<StatusDto | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.status();
        if (!alive) return;
        setStatus(s);
        timer = setTimeout(tick, s.embedding.pending > 0 ? 2500 : 15000);
      } catch {
        if (alive) timer = setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}

function EmbeddingNote({ s }: { s: StatusDto | null }) {
  if (!s) return null;
  const e = s.embedding;
  if (e.state === "off") return <span className="muted small">Meaning search off</span>;
  if (e.state === "unavailable")
    return (
      <span className="small warn" title={e.error}>
        Meaning search unavailable (keyword search still works)
      </span>
    );
  if (e.pending > 0) return <span className="small muted">Building meaning index… {e.pending} left</span>;
  return <span className="small muted">Meaning search ready</span>;
}

export function App() {
  const route = useRoute();
  const status = useStatus();
  const section = route.path[0] ?? "library";
  const [q, setQ] = useState("");

  useEffect(() => {
    if (section === "search") setQ(route.params.get("q") ?? "");
  }, [section, route.params]);

  let page;
  if (section === "search") page = <SearchPage route={route} />;
  else if (section === "reader") page = <ReaderPage route={route} status={status} />;
  else if (section === "knowledge") page = <KnowledgePage route={route} />;
  else if (section === "settings") page = <SettingsPage status={status} />;
  else page = <LibraryPage />;

  const reading = section === "reader";
  return (
    <ToastProvider>
      <header className="topbar">
        <a className="brand" href={href("")}>
          Smart Reading
        </a>
        <nav>
          {[
            ["library", "Library", ""],
            ["search", "Search", "search"],
            ["knowledge", "Knowledge", "knowledge"],
            ["settings", "Settings", "settings"],
          ].map(([key, label, path]) => (
            <a key={key} href={href(path)} className={section === key || (key === "library" && section === "reader") ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <form
          className="globalsearch"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) go("search", { q: q.trim() });
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything you've read and kept…"
            aria-label="Search"
          />
        </form>
        <EmbeddingNote s={status} />
      </header>
      <main className={reading ? "reading" : ""}>{page}</main>
    </ToastProvider>
  );
}
