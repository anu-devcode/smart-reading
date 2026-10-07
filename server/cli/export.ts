import { loadConfig } from "../config.ts";
import { exportToDir } from "../knowledge/export.ts";
import { closeLibraries, openLibraries, userArg } from "./open.ts";

// usage: npm run export [-- --user <name>]   (with accounts and no --user, every account is exported)
try {
  const libs = openLibraries(loadConfig({ embeddings: "off" }), { username: userArg(process.argv) });
  for (const l of libs) {
    const { dir, files } = exportToDir(l.ctx);
    console.log(`Exported${l.username ? ` ${l.username}'s library` : ""} to ${dir}`);
    files.forEach((f) => console.log("  " + f));
  }
  closeLibraries(libs);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
