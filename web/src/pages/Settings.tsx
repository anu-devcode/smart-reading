import { useEffect, useState } from "react";
import type { AccountDto, SettingsDto, StatusDto } from "../../../shared/types";
import { api } from "../api";
import { Loading, PageHeader, useToast } from "../components";

const PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "local-model" },
];

function AccountSection({ account }: { account: AccountDto }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <section className="card">
      <h3>Your account</h3>
      <p className="small">
        Signed in as <strong>{account.username}</strong>
        {account.isAdmin && <span className="chip">owner</span>}. Your library is private: nobody else on this server can see your documents or what you keep.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.changePassword(current, next);
            setCurrent("");
            setNext("");
            toast("Password changed. Other devices have to sign in again.");
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <label className="field">
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="field">
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        <button type="submit">Change password</button>
      </form>
    </section>
  );
}

function PeopleSection({ me }: { me: AccountDto }) {
  const toast = useToast();
  const [people, setPeople] = useState<AccountDto[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const load = () => api.accounts().then(setPeople, (e) => toast((e as Error).message, "error"));
  useEffect(() => void load(), []);

  return (
    <section className="card">
      <h3>People</h3>
      <p className="muted small">
        Everyone gets their own library. There is no sign-up page: add people here and give them their password. They can change it in Settings.
      </p>
      <ul className="plain">
        {people.map((p) => (
          <li key={p.id} className="row between">
            <span>
              {p.username} {p.isAdmin && <span className="chip">owner</span>}
            </span>
            {p.id !== me.id && (
              <span className="row">
                <button
                  className="link small"
                  onClick={async () => {
                    const pw = prompt(`New password for ${p.username} (at least 10 characters). They will be signed out everywhere.`);
                    if (!pw) return;
                    try {
                      await api.resetPassword(p.id, pw);
                      toast(`Password for ${p.username} changed.`);
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }}
                >
                  Set password
                </button>
                <button
                  className="link small danger"
                  onClick={async () => {
                    const typed = prompt(`This deletes ${p.username}'s whole library: documents, highlights and everything they kept. It cannot be undone.\n\nType "${p.username}" to confirm.`);
                    if (typed === null) return;
                    try {
                      await api.removeAccount(p.id, typed);
                      toast(`${p.username} and their library were removed.`);
                      void load();
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const a = await api.addAccount(username, password);
            setUsername("");
            setPassword("");
            toast(`${a.username} can now sign in.`);
            void load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        <input type="password" placeholder="Their password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
        <button type="submit">Add person</button>
      </form>
    </section>
  );
}

export function SettingsPage({ status, account }: { status: StatusDto | null; account: AccountDto | null }) {
  const toast = useToast();
  const [s, setS] = useState<SettingsDto | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [ocrOn, setOcrOn] = useState(true);
  const [ocrLang, setOcrLang] = useState("eng");
  const [exported, setExported] = useState<{ dir: string; files: string[] } | null>(null);

  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setBaseUrl(x.ai.baseUrl);
      setModel(x.ai.model);
      setOcrOn(x.ocr.enabled);
      setOcrLang(x.ocr.language);
    });
  }, []);

  const saveOcr = async () => {
    try {
      const x = await api.saveOcrSettings({ enabled: ocrOn, language: ocrLang });
      setS(x);
      setOcrOn(x.ocr.enabled);
      setOcrLang(x.ocr.language);
      toast(x.ocr.enabled ? "OCR is on. Scanned pages are read in the background." : "OCR is off.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const save = async () => {
    try {
      const x = await api.saveSettings({ baseUrl, model, apiKey: apiKey || undefined });
      setS(x);
      setApiKey("");
      toast("Settings saved.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page narrow">
      <PageHeader eyebrow="Settings" title="Your preferences">
        Your account, optional suggestions, scanned pages, search and your data.
      </PageHeader>

      {account && <AccountSection account={account} />}
      {account?.isAdmin && <PeopleSection me={account} />}

      <section className="card">
        <h3>Suggestions with Distill (optional)</h3>
        <p className="muted small">
          Distill proposes ideas, concepts and questions from a passage you selected. It never saves anything by itself. Any OpenAI-compatible endpoint works, including local models. Your key is stored only in your own library folder{account ? " on the server" : " on this computer"}, is used only for your library, and is never included in backups.
        </p>
        <div className="row">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => (setBaseUrl(p.baseUrl), setModel(p.model))}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="field">
          Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label className="field">
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
        </label>
        <label className="field">
          API key {s?.ai.apiKeySet && <span className="chip">saved</span>}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s?.ai.apiKeySet ? "Leave blank to keep the saved key" : "Not needed for local models"} autoComplete="off" />
        </label>
        <button className="primary" onClick={() => void save()}>
          Save
        </button>
      </section>

      <section className="card">
        <h3>Scanned pages (OCR)</h3>
        <p className="muted small">
          Pages that are only a picture of text have nothing to search. With OCR on, they are read in the background, on this computer, and the text appears page by page. A page that cannot be read reliably is left unreadable, with the reason, instead of being guessed at. Text read this way is marked <span className="chip">OCR</span> and may contain mistakes. Your original file is never changed.
        </p>
        <label className="row">
          <input type="checkbox" checked={ocrOn} onChange={(e) => setOcrOn(e.target.checked)} />
          Read scanned pages with OCR
        </label>
        <label className="field">
          Language
          <input value={ocrLang} onChange={(e) => setOcrLang(e.target.value)} placeholder="eng" />
        </label>
        <p className="muted small">
          A Tesseract language code, such as <code>eng</code>, <code>deu</code> or <code>fra</code>; join several with <code>+</code>, such as <code>eng+deu</code>. The language data (a few MB) is downloaded the first time and kept in your library folder.
        </p>
        <button className="primary" onClick={() => void saveOcr()}>
          Save
        </button>
        {status && (
          <p className="small">
            State: {status.ocr.enabled ? status.ocr.state : "off"}
            {status.ocr.pending > 0 && status.ocr.enabled && ` (${status.ocr.pending} pages left)`}
            {status.ocr.error && <span className="warn"> · {status.ocr.error}</span>}
          </p>
        )}
      </section>

      <section className="card">
        <h3>Search by meaning</h3>
        {status ? (
          <p className="small">
            Model: <code>{status.embedding.model}</code>
            <br />
            State: {status.embedding.state}
            {status.embedding.pending > 0 && ` (${status.embedding.pending} passages left)`}
            {status.embedding.error && <span className="warn"> · {status.embedding.error}</span>}
          </p>
        ) : (
          <Loading label="Loading search status…" rows={1} />
        )}
        <p className="muted small">
          Meaning vectors are derived data: they can be rebuilt at any time with <code>npm run embeddings:rebuild</code>. Your sources and what you keep never depend on this model.
        </p>
      </section>

      <section className="card">
        <h3>Your data</h3>
        <p className="small">
          Library folder: <code>{status?.libraryDir}</code>
        </p>
        <div className="row">
          <button
            onClick={async () => {
              try {
                setExported(await api.exportNow());
              } catch (e) {
                toast((e as Error).message, "error");
              }
            }}
          >
            Export to a folder
          </button>
          <a className="btn" href="/api/export.json" download="smart-reading-export.json">
            Download JSON
          </a>
          <a className="btn" href="/api/export.md" download="smart-reading-knowledge.md">
            Download Markdown
          </a>
        </div>
        {exported && (
          <p className="small">
            Exported to <code>{exported.dir}</code>
          </p>
        )}
        <p className="muted small">
          The export holds your sources list, highlights, everything you accepted, connections, and exact source locations. No AI data is needed to read it.
        </p>
        {(!account || account.isAdmin) && (
          <p className="muted small">
            Backup (run with the app stopped or running){account ? ", covering every account" : ""}: <code>npm run backup -- create</code>. Restore into an empty library: <code>npm run backup -- restore &lt;folder&gt;</code>.
          </p>
        )}
      </section>
    </div>
  );
}
