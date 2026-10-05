import { loadConfig } from "../config.ts";
import { createContext } from "../context.ts";

const cfg = loadConfig();
if (cfg.embeddings === "off") {
  console.error("EMBEDDINGS is off. Unset EMBEDDINGS=off to rebuild.");
  process.exit(1);
}
const ctx = createContext(cfg);
console.log(`Rebuilding embeddings with ${cfg.embeddingModel} ...`);
const before = ctx.embedJob.pendingCount();
const started = Date.now();
await ctx.embedJob.rebuild();
if (ctx.embedJob.state === "unavailable") {
  console.error(`Failed: ${ctx.embedJob.error}`);
  process.exit(1);
}
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Pending before: ${before}, after: ${ctx.embedJob.pendingCount()}.`);
ctx.db.close();
