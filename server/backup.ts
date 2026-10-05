import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "./context.ts";

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
