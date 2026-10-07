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
  /** address to listen on; anything other than 127.0.0.1 / localhost makes the app reachable from other devices */
  host: string;
  /** "off" = a single library with no sign-in, only allowed on this computer */
  accounts: "on" | "off";
  /** behind a reverse proxy that terminates HTTPS: trust X-Forwarded-* headers */
  trustProxy: boolean;
  embeddings: "on" | "off";
  embeddingModel: string;
  /** default for reading scanned pages with OCR; the user can change it in Settings */
  ocr: "on" | "off";
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
    host: process.env.HOST ?? "127.0.0.1",
    accounts: (process.env.ACCOUNTS as "on" | "off") === "off" ? "off" : "on",
    trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
    embeddings: (process.env.EMBEDDINGS as "on" | "off") === "off" ? "off" : "on",
    // Multilingual, 384-dim, chosen in the feasibility spike (see README).
    embeddingModel: process.env.EMBED_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    semanticMin: Number(process.env.SEMANTIC_MIN ?? 0.4),
    ocr: (process.env.OCR as "on" | "off") === "off" ? "off" : "on",
    ...overrides,
  };
}

/** One account's library: its own folder, database, originals and settings; models are shared. */
export function libraryConfig(base: Config, dir: string): Config {
  const libraryDir = resolve(dir);
  const originalsDir = join(libraryDir, "originals");
  mkdirSync(originalsDir, { recursive: true });
  return {
    ...base,
    libraryDir,
    originalsDir,
    dbFile: join(libraryDir, "library.db"),
    settingsFile: join(libraryDir, "settings.json"),
  };
}

export const isLocalHost = (host: string) => ["127.0.0.1", "localhost", "::1"].includes(host);

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

function readSettingsFile(cfg: Config): Record<string, unknown> {
  if (!existsSync(cfg.settingsFile)) return {};
  try {
    const v = JSON.parse(readFileSync(cfg.settingsFile, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeAiSettings(cfg: Config, ai: Partial<AiSettings>): void {
  const current = readAiSettings(cfg);
  const next = {
    baseUrl: ai.baseUrl ?? current.baseUrl,
    model: ai.model ?? current.model,
    // empty string from the UI means "keep the existing key"
    apiKey: ai.apiKey ? ai.apiKey : current.apiKey,
  };
  writeFileSync(cfg.settingsFile, JSON.stringify({ ...readSettingsFile(cfg), ai: next }, null, 2), "utf8");
}

// ---------- OCR ----------

export interface OcrSettings {
  enabled: boolean;
  /** Tesseract language code(s), e.g. "eng" or "eng+deu" */
  language: string;
}

export const OCR_LANGUAGE_PATTERN = /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?)*$/i;

export function readOcrSettings(cfg: Config): OcrSettings {
  const stored = (readSettingsFile(cfg).ocr ?? {}) as Partial<OcrSettings>;
  const language = typeof stored.language === "string" && OCR_LANGUAGE_PATTERN.test(stored.language) ? stored.language : "eng";
  return { enabled: typeof stored.enabled === "boolean" ? stored.enabled : cfg.ocr === "on", language };
}

export function writeOcrSettings(cfg: Config, ocr: Partial<OcrSettings>): void {
  const current = readOcrSettings(cfg);
  const language = ocr.language?.trim() ?? current.language;
  if (!OCR_LANGUAGE_PATTERN.test(language)) {
    throw new Error('Use a Tesseract language code such as "eng", or several joined with "+", such as "eng+deu".');
  }
  const next: OcrSettings = { enabled: ocr.enabled ?? current.enabled, language };
  writeFileSync(cfg.settingsFile, JSON.stringify({ ...readSettingsFile(cfg), ocr: next }, null, 2), "utf8");
}
