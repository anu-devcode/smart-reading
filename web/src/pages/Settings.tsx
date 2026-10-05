import { useEffect, useState } from "react";
import type { SettingsDto, StatusDto } from "../../../shared/types";
import { api } from "../api";
import { useToast } from "../components";

const PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "local-model" },
];

export function SettingsPage({ status }: { status: StatusDto | null }) {
  const toast = useToast();
  const [s, setS] = useState<SettingsDto | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [exported, setExported] = useState<{ dir: string; files: string[] } | null>(null);

  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setBaseUrl(x.ai.baseUrl);
      setModel(x.ai.model);
    });
  }, []);

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
      <h2>Settings</h2>

      <section className="card">
        <h3>AI for Distill (optional)</h3>
        <p className="muted small">
          Distill proposes ideas, concepts and questions from a passage you selected. It never saves anything by itself. Any OpenAI-compatible endpoint works, including local models. Your key is stored only in the library folder on this computer and is never included in backups.
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
        <h3>Meaning search</h3>
        {status ? (
          <p className="small">
            Model: <code>{status.embedding.model}</code>
            <br />
            State: {status.embedding.state}
            {status.embedding.pending > 0 && ` (${status.embedding.pending} passages left)`}
            {status.embedding.error && <span className="warn"> · {status.embedding.error}</span>}
          </p>
        ) : (
          <p className="muted">Loading…</p>
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
        <p className="muted small">
          Backup (run with the app stopped or running): <code>npm run backup -- create</code>. Restore into an empty library: <code>npm run backup -- restore &lt;folder&gt;</code>.
        </p>
      </section>
    </div>
  );
}
