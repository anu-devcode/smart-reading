import { useEffect, useState } from "react";
import type { AccountDto, SessionDto, StatusDto } from "../../shared/types";
import { api, SIGNED_OUT } from "./api";
import { SignInPage } from "./pages/SignIn";
import { BrandLockup } from "./brand";
import { PUBLIC_PAGES, PublicPage } from "./site/Public";
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
  if (e.state === "off") return <span className="status-pill" title="Search by meaning is turned off. Searching by words works.">Word search</span>;
  if (e.state === "unavailable")
    return (
      <span className="status-pill warn" title={`Search by meaning is unavailable${e.error ? `: ${e.error}` : ""}. Searching by words still works.`}>
        Word search only
      </span>
    );
  if (e.pending > 0)
    return (
      <span className="status-pill busy" title="Searching by words works now. Search by meaning is still preparing.">
        Preparing search… {e.pending} left
      </span>
    );
  return (
    <span className="status-pill ok" title="Search by words and by meaning is ready">
      Search ready
    </span>
  );
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionDto | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = () =>
    api.session().then(
      (s) => (setSession(s), setFailed(false)),
      () => setFailed(true),
    );
  useEffect(() => {
    void refresh();
    const onSignedOut = () => void refresh();
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  if (failed) return <p className="page muted">Cannot reach the Anbabi server. Is it running?</p>;
  if (!session) return null;
  const page = route.path[0] ?? "";
  const signedIn = !session.accounts || !!session.account;
  if (!signedIn) {
    // Signed out: the public site. A link into the app (e.g. a reader page) asks to sign in, then opens it.
    const signIn = (
      <SignInPage
        setup={session.setupNeeded}
        onSignedIn={(account) => {
          if (page === "signin") go("");
          setSession({ ...session, setupNeeded: false, account });
        }}
      />
    );
    const known = page === "" || PUBLIC_PAGES.includes(page);
    return (
      <ToastProvider>
        <PublicPage page={known ? page : "signin"} signedIn={false} signIn={signIn} />
      </ToastProvider>
    );
  }
  if (PUBLIC_PAGES.includes(page) && page !== "signin") {
    return <PublicPage page={page} signedIn signIn={null} />;
  }
  if (page === "signin") go("");
  return (
    <Shell
      key={session.account?.id ?? 0}
      account={session.account}
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        await refresh();
      }}
    />
  );
}

function Shell({ account, onSignOut }: { account: AccountDto | null; onSignOut: () => void }) {
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
  else if (section === "settings") page = <SettingsPage status={status} account={account} />;
  else page = <LibraryPage />;

  const reading = section === "reader";
  return (
    <ToastProvider>
      <header className="topbar">
        <a className="brand" href={href("")} aria-label="Anbabi, home">
          <BrandLockup />
        </a>
        <nav aria-label="Main">
          {[
            ["library", "Library", "", "Your documents, and new ones as they arrive"],
            ["search", "Search", "search", "Find passages and what you kept"],
            ["knowledge", "Workshop", "knowledge", "Everything you kept, to edit and connect"],
            ["settings", "Settings", "settings", "Account and preferences"],
          ].map(([key, label, path, title]) => {
            const active = section === key || (key === "library" && section === "reader");
            return (
              <a key={key} href={href(path)} title={title} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                {label}
              </a>
            );
          })}
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
        {account && (
          <span className="account small">
            <a className="muted" href={href("home")}>
              About
            </a>
            <span className="muted">{account.username}</span>
            <button className="link small" onClick={onSignOut}>
              Sign out
            </button>
          </span>
        )}
      </header>
      <main className={reading ? "reading" : ""}>{page}</main>
    </ToastProvider>
  );
}
