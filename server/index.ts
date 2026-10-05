import { loadConfig } from "./config.ts";
import { createContext } from "./context.ts";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
const ctx = createContext(cfg);
const app = await buildApp(ctx, { serveWeb: true });

// Bind to localhost only: this is a personal, local-first app with no accounts.
await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.log(`Smart Reading is running at http://localhost:${cfg.port}`);
console.log(`Library folder: ${cfg.libraryDir}`);
console.log(`Meaning search: ${cfg.embeddings === "on" ? cfg.embeddingModel : "off"}`);

// Fill in any missing embeddings in the background (also warms up the model).
void ctx.embedJob.kick();

const shutdown = async () => {
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
