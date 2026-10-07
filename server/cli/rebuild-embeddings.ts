import { loadConfig } from "../config.ts";
import { TransformersEmbedder } from "../search/embeddings.ts";
import { closeLibraries, openLibraries } from "./open.ts";

const cfg = loadConfig();
if (cfg.embeddings === "off") {
  console.error("EMBEDDINGS is off. Unset EMBEDDINGS=off to rebuild.");
  process.exit(1);
}
const libs = openLibraries(cfg, { embedder: new TransformersEmbedder(cfg.embeddingModel, cfg.modelsDir) });
console.log(`Rebuilding embeddings with ${cfg.embeddingModel} ...`);
for (const { ctx, username } of libs) {
  const before = ctx.embedJob.pendingCount();
  const started = Date.now();
  await ctx.embedJob.rebuild();
  if (ctx.embedJob.state === "unavailable") {
    console.error(`Failed: ${ctx.embedJob.error}`);
    process.exit(1);
  }
  const who = username ? `${username}: ` : "";
  console.log(`${who}done in ${((Date.now() - started) / 1000).toFixed(1)}s. Pending before: ${before}, after: ${ctx.embedJob.pendingCount()}.`);
}
closeLibraries(libs);
