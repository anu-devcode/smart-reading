import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AiSettings {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama) */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Config {
  libraryDir: string;
  originalsDir: string;
  modelsDir: string;
  dbFile: string;
  settingsFile: string;
  port: number;
  embeddings: "on" | "off";
  embeddingModel: string;
  /** minimum cosine similarity for a meaning-only hit to be shown */
  semanticMin: number;
}

export function loadConfig(overrides: Partial<Config> & { libraryDir?: string } = {}): Config {
  const libraryDir = resolve(overrides.libraryDir ?? process.env.LIBRARY_DIR ?? "library-data");
  const originalsDir = join(libraryDir, "originals");
  const modelsDir = join(libraryDir, "models");
  mkdirSync(originalsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  return {
    libraryDir,
    originalsDir,
    modelsDir,
    dbFile: join(libraryDir, "library.db"),
    settingsFile: join(libraryDir, "settings.json"),
    port: Number(process.env.PORT ?? 4177),
    embeddings: (process.env.EMBEDDINGS as "on" | "off") === "off" ? "off" : "on",
    // Multilingual, 384-dim, chosen in the feasibility spike (see README).
    embeddingModel: process.env.EMBED_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    semanticMin: Number(process.env.SEMANTIC_MIN ?? 0.4),
    ...overrides,
  };
}

const DEFAULT_AI: AiSettings = { baseUrl: "", model: "", apiKey: "" };

export function readAiSettings(cfg: Config): AiSettings {
  const fromEnv: Partial<AiSettings> = {
    baseUrl: process.env.AI_BASE_URL,
    model: process.env.AI_MODEL,
    apiKey: process.env.AI_API_KEY,
  };
  let stored: Partial<AiSettings> = {};
  if (existsSync(cfg.settingsFile)) {
    try {
      stored = JSON.parse(readFileSync(cfg.settingsFile, "utf8")).ai ?? {};
    } catch {
      stored = {};
    }
  }
  return {
    baseUrl: fromEnv.baseUrl || stored.baseUrl || DEFAULT_AI.baseUrl,
    model: fromEnv.model || stored.model || DEFAULT_AI.model,
    apiKey: fromEnv.apiKey || stored.apiKey || DEFAULT_AI.apiKey,
  };
}

export function writeAiSettings(cfg: Config, ai: Partial<AiSettings>): void {
  const current = readAiSettings(cfg);
  const next = {
    baseUrl: ai.baseUrl ?? current.baseUrl,
    model: ai.model ?? current.model,
    // empty string from the UI means "keep the existing key"
    apiKey: ai.apiKey ? ai.apiKey : current.apiKey,
  };
  writeFileSync(cfg.settingsFile, JSON.stringify({ ai: next }, null, 2), "utf8");
}
