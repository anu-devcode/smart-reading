import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Ctx } from "./context.ts";
import type { DB } from "./db.ts";

// Backup = one consistent SQLite snapshot + the original files. Derived data (embeddings model cache)
// is not copied, and the AI API key is never written to a backup.

export interface BackupManifest {
  version: 1;
  createdAt: string;
  documents: number;
}

export async function createBackup(ctx: Ctx, destDir: string): Promise<{ dir: string; manifest: BackupManifest }> {
  const dir = resolve(destDir);
  if (existsSync(join(dir, "library.db"))) {
    throw new Error(`A backup already exists in ${dir}. Choose a new folder.`);
  }
  mkdirSync(dir, { recursive: true });
  await ctx.db.backup(join(dir, "library.db")); // consistent even while the app is running
  if (existsSync(ctx.cfg.originalsDir)) cpSync(ctx.cfg.originalsDir, join(dir, "originals"), { recursive: true });

  if (existsSync(ctx.cfg.settingsFile)) {
    try {
      const s = JSON.parse(readFileSync(ctx.cfg.settingsFile, "utf8"));
      if (s?.ai) s.ai.apiKey = "";
      writeFileSync(join(dir, "settings.json"), JSON.stringify(s, null, 2), "utf8");
    } catch {
      /* settings are optional */
    }
  }
  const n = (ctx.db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c;
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), documents: n };
  writeFileSync(join(dir, "backup.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest };
}

/** Restore a backup into a library folder. Must be run while the app is stopped. */
export function restoreBackup(srcDir: string, libraryDir: string, opts: { force?: boolean } = {}): BackupManifest {
  const src = resolve(srcDir);
  const dest = resolve(libraryDir);
  if (!existsSync(join(src, "backup.json")) || !existsSync(join(src, "library.db"))) {
    throw new Error(`${src} is not a backup folder (missing backup.json or library.db).`);
  }
  if (existsSync(join(dest, "library.db")) && !opts.force) {
    throw new Error(`${dest} already contains a library. Use --force to replace it.`);
  }
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(dest)) {
    if (f === "library.db" || f.startsWith("library.db-")) rmSync(join(dest, f), { force: true });
  }
  if (existsSync(join(dest, "originals"))) rmSync(join(dest, "originals"), { recursive: true, force: true });
  cpSync(join(src, "library.db"), join(dest, "library.db"));
  if (existsSync(join(src, "originals"))) cpSync(join(src, "originals"), join(dest, "originals"), { recursive: true });
  if (existsSync(join(src, "settings.json")) && !existsSync(join(dest, "settings.json"))) {
    cpSync(join(src, "settings.json"), join(dest, "settings.json"));
  }
  return JSON.parse(readFileSync(join(src, "backup.json"), "utf8")) as BackupManifest;
}

// ---------- with accounts: the accounts file plus one library backup per account ----------

export interface ServerBackupManifest {
  version: 2;
  createdAt: string;
  accounts: number;
  documents: number;
}

export async function createServerBackup(
  accountsDb: DB,
  libraries: { id: number; ctx: Ctx }[],
  destDir: string,
): Promise<{ dir: string; manifest: ServerBackupManifest }> {
  const dir = resolve(destDir);
  if (existsSync(join(dir, "backup.json"))) throw new Error(`A backup already exists in ${dir}. Choose a new folder.`);
  mkdirSync(dir, { recursive: true });
  await accountsDb.backup(join(dir, "accounts.db"));
  let documents = 0;
  for (const l of libraries) documents += (await createBackup(l.ctx, join(dir, "users", String(l.id)))).manifest.documents;
  const manifest: ServerBackupManifest = { version: 2, createdAt: new Date().toISOString(), accounts: libraries.length, documents };
  writeFileSync(join(dir, "backup.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest };
}

export const isServerBackup = (dir: string) => existsSync(join(resolve(dir), "accounts.db"));

/** Restore accounts and every library. Must be run while the app is stopped. Everyone signs in again. */
export function restoreServerBackup(srcDir: string, libraryDir: string, opts: { force?: boolean } = {}): ServerBackupManifest {
  const src = resolve(srcDir);
  const dest = resolve(libraryDir);
  if (!existsSync(join(src, "backup.json")) || !isServerBackup(src)) throw new Error(`${src} is not a server backup (missing accounts.db).`);
  if (existsSync(join(dest, "accounts.db")) && !opts.force) throw new Error(`${dest} already has accounts. Use --force to replace them.`);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(dest)) {
    if (f === "accounts.db" || f.startsWith("accounts.db-")) rmSync(join(dest, f), { force: true });
  }
  rmSync(join(dest, "users"), { recursive: true, force: true });
  cpSync(join(src, "accounts.db"), join(dest, "accounts.db"));
  const db = new Database(join(dest, "accounts.db"));
  db.exec("DELETE FROM sessions");
  db.close();
  const users = join(src, "users");
  if (existsSync(users)) for (const id of readdirSync(users)) restoreBackup(join(users, id), join(dest, "users", id), { force: true });
  return JSON.parse(readFileSync(join(src, "backup.json"), "utf8")) as ServerBackupManifest;
}
