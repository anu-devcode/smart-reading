import { loadConfig } from "../config.ts";
import { createContext } from "../context.ts";
import { createBackup, restoreBackup } from "../backup.ts";

// usage:
//   npm run backup -- create [destDir]
//   npm run backup -- restore <backupDir> [--force]
const [cmd, arg, flag] = process.argv.slice(2);
const cfg = loadConfig({ embeddings: "off" });

try {
  if (cmd === "create") {
    const ctx = createContext(cfg, { embedder: null });
    const dest = arg ?? `${cfg.libraryDir}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const { dir, manifest } = await createBackup(ctx, dest);
    console.log(`Backup of ${manifest.documents} document(s) written to ${dir}`);
    ctx.db.close();
  } else if (cmd === "restore" && arg) {
    console.log("Restoring. Make sure the app is stopped.");
    const manifest = restoreBackup(arg, cfg.libraryDir, { force: flag === "--force" });
    console.log(`Restored ${manifest.documents} document(s) from ${arg} into ${cfg.libraryDir}`);
    console.log("Start the app; any missing meaning-search vectors are rebuilt in the background.");
  } else {
    console.log("usage: npm run backup -- create [destDir]\n       npm run backup -- restore <backupDir> [--force]");
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
