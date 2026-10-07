import { isLocalHost, loadConfig } from "./config.ts";
import { createContext } from "./context.ts";
import { buildApp } from "./app.ts";
import { Accounts } from "./accounts.ts";
import { Libraries } from "./libraries.ts";

const cfg = loadConfig();

if (cfg.accounts === "off" && !isLocalHost(cfg.host)) {
  console.error(`ACCOUNTS=off means anyone who can reach the server can read your library. It only runs on this computer (HOST=127.0.0.1), not on ${cfg.host}.`);
  process.exit(1);
}

let close: () => Promise<void>;
let app;
if (cfg.accounts === "off") {
  const ctx = createContext(cfg);
  app = await buildApp(ctx, { serveWeb: true });
  void ctx.embedJob.kick();
  void ctx.ocrJob.kick();
  close = async () => {
    await ctx.ocrJob.close();
    ctx.db.close();
  };
} else {
  const accounts = new Accounts(cfg.libraryDir);
  const libraries = new Libraries(cfg);
  // Open every library so missing embeddings and waiting scanned pages are filled in without a visit.
  for (const a of accounts.list()) libraries.forUser(a.id);
  app = await buildApp({ accounts, libraries }, { serveWeb: true, trustProxy: cfg.trustProxy });
  close = async () => {
    await libraries.closeAll();
    accounts.close();
  };
}

await app.listen({ port: cfg.port, host: cfg.host });
const shown = isLocalHost(cfg.host) ? "localhost" : cfg.host;
console.log(`Smart Reading is running at http://${shown}:${cfg.port}`);
console.log(`Library folder: ${cfg.libraryDir}`);
console.log(`Accounts: ${cfg.accounts === "off" ? "off (one library, this computer only)" : "on"}`);
console.log(`Meaning search: ${cfg.embeddings === "on" ? cfg.embeddingModel : "off"}`);
if (!isLocalHost(cfg.host) && !cfg.trustProxy) {
  console.log("Reachable from other devices over plain HTTP: passwords cross the network unencrypted. Put HTTPS in front (see README).");
}

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
