import { loadConfig } from "../config.ts";
import { createContext } from "../context.ts";
import { exportToDir } from "../knowledge/export.ts";

const ctx = createContext(loadConfig({ embeddings: "off" }), { embedder: null });
const { dir, files } = exportToDir(ctx);
console.log(`Exported to ${dir}`);
files.forEach((f) => console.log("  " + f));
ctx.db.close();
