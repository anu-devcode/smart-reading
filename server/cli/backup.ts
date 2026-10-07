import Database from "better-sqlite3";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { createBackup, createServerBackup, isServerBackup, restoreBackup, restoreServerBackup } from "../backup.ts";
import { closeLibraries, hasAccounts, openLibraries, userArg } from "./open.ts";

// usage:
//   npm run backup -- create [destDir]
//   npm run backup -- restore <backupDir> [--force] [--user <name>]
// With accounts, a backup holds the accounts and every account's library.
const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig({ embeddings: "off" });

try {
  if (cmd === "create") {
    const dest = arg ?? `${cfg.libraryDir}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const libs = openLibraries(cfg);
    if (hasAccounts(cfg)) {
      const accountsDb = new Database(join(cfg.libraryDir, "accounts.db"), { readonly: true });
      const { dir, manifest } = await createServerBackup(accountsDb, libs.map((l) => ({ id: l.id!, ctx: l.ctx })), dest);
      accountsDb.close();
      console.log(`Backup of ${manifest.accounts} account(s) and ${manifest.documents} document(s) written to ${dir}`);
    } else {
      const { dir, manifest } = await createBackup(libs[0].ctx, dest);
      console.log(`Backup of ${manifest.documents} document(s) written to ${dir}`);
    }
    closeLibraries(libs);
  } else if (cmd === "restore" && arg) {
    console.log("Restoring. Make sure the app is stopped.");
    const force = process.argv.includes("--force");
    if (isServerBackup(arg)) {
      const m = restoreServerBackup(arg, cfg.libraryDir, { force });
      console.log(`Restored ${m.accounts} account(s) and ${m.documents} document(s) from ${arg} into ${cfg.libraryDir}. Everyone signs in again.`);
    } else if (hasAccounts(cfg)) {
      // a one-library backup goes into one account's library
      const username = userArg(process.argv);
      if (!username) throw new Error("This backup holds a single library. Choose the account it belongs to: --user <name>");
      const [lib] = openLibraries(cfg, { username });
      const dir = lib.ctx.cfg.libraryDir;
      closeLibraries([lib]);
      const m = restoreBackup(arg, dir, { force });
      console.log(`Restored ${m.documents} document(s) from ${arg} into ${username}'s library`);
    } else {
      const m = restoreBackup(arg, cfg.libraryDir, { force });
      console.log(`Restored ${m.documents} document(s) from ${arg} into ${cfg.libraryDir}`);
    }
    console.log("Start the app; any missing meaning-search vectors are rebuilt in the background.");
  } else {
    console.log("usage: npm run backup -- create [destDir]\n       npm run backup -- restore <backupDir> [--force]");
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
