import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { libraryConfig, type Config } from "../config.ts";
import { createContext, type Ctx } from "../context.ts";
import type { Embedder } from "../search/embeddings.ts";

export interface CliLibrary {
  /** account id, or null for a library without accounts */
  id: number | null;
  username: string | null;
  ctx: Ctx;
}

export const hasAccounts = (cfg: Config) => existsSync(join(cfg.libraryDir, "accounts.db"));

/** Every library in the library folder: one per account, or the single one when accounts were never used. */
export function openLibraries(cfg: Config, opts: { embedder?: Embedder | null; username?: string } = {}): CliLibrary[] {
  const shared = { embedder: opts.embedder ?? null, ocr: null };
  if (!hasAccounts(cfg)) return [{ id: null, username: null, ctx: createContext(cfg, shared) }];
  const db = new Database(join(cfg.libraryDir, "accounts.db"), { readonly: true });
  const users = db.prepare("SELECT id, username FROM users ORDER BY id").all() as { id: number; username: string }[];
  db.close();
  const chosen = opts.username ? users.filter((u) => u.username.toLowerCase() === opts.username!.toLowerCase()) : users;
  if (opts.username && !chosen.length) throw new Error(`No account named "${opts.username}".`);
  return chosen.map((u) => ({
    id: u.id,
    username: u.username,
    ctx: createContext(libraryConfig(cfg, join(cfg.libraryDir, "users", String(u.id))), shared),
  }));
}

export function closeLibraries(libs: CliLibrary[]): void {
  for (const l of libs) l.ctx.db.close();
}

/** `--user name` from the command line */
export function userArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--user");
  return i >= 0 ? argv[i + 1] : undefined;
}
