import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./context.ts";
import type { AccountDto, SessionDto, StatusDto } from "../shared/types.ts";
import { readAiSettings, readOcrSettings } from "./config.ts";
import { registerLibraryRoutes } from "./routes/library.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerLookupRoutes } from "./routes/library-extra.ts";
import { registerKnowledgeRoutes } from "./routes/knowledge.ts";
import { readSessionToken, registerAuthRoutes } from "./routes/auth.ts";
import type { DistillProvider } from "./knowledge/distill.ts";
import type { Accounts } from "./accounts.ts";
import type { Libraries } from "./libraries.ts";
import { HttpError } from "./errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** the signed-in person's library (set for every /api request that needs one) */
    ctx: Ctx;
    account: AccountDto | null;
  }
}

/** Either one library with no sign-in (this computer only), or accounts with a library each. */
export type AppSource = Ctx | { accounts: Accounts; libraries: Libraries };

export interface AppOptions {
  /** override the AI provider (tests) */
  provider?: DistillProvider;
  serveWeb?: boolean;
  /** behind a reverse proxy: trust X-Forwarded-* for the client address, host and protocol */
  trustProxy?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browsers send Origin with every write; one from another site means someone else's page is acting for you. */
function fromAnotherSite(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.host;
  } catch {
    return true;
  }
}

export async function buildApp(source: AppSource, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: opts.trustProxy ?? false });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 50 } });

  app.setErrorHandler((err: Error & { statusCode?: number; status?: number }, _req, reply) => {
    const code = err instanceof HttpError ? err.status : err.statusCode;
    const status = code && code >= 400 ? code : 500;
    reply.status(status).send({ error: err.message });
  });

  app.decorateRequest("ctx", null as unknown as Ctx);
  app.decorateRequest("account", null);

  const multi = "libraries" in source ? source : null;
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (fromAnotherSite(req)) return reply.status(403).send({ error: "Requests from other websites are not accepted." });
    if (!multi) {
      req.ctx = source as Ctx;
      return;
    }
    req.account = multi.accounts.sessionAccount(readSessionToken(req));
    if (req.url.startsWith("/api/auth/")) return;
    if (!req.account) return reply.status(401).send({ error: "Sign in first." });
    req.ctx = multi.libraries.forUser(req.account.id);
  });

  if (multi) registerAuthRoutes(app, multi.accounts, multi.libraries);
  else app.get("/api/auth/session", async (): Promise<SessionDto> => ({ accounts: false, setupNeeded: false, account: null }));

  app.get("/api/status", async (req): Promise<StatusDto> => {
    const ctx = req.ctx;
    const ai = readAiSettings(ctx.cfg);
    return {
      embedding: {
        state: ctx.embedder ? ctx.embedJob.state : "off",
        model: ctx.cfg.embeddingModel,
        pending: ctx.embedJob.pendingCount(),
        error: ctx.embedJob.error,
      },
      ai: { configured: !!(ai.baseUrl && ai.model), model: ai.model || null },
      ocr: {
        enabled: ctx.ocrJob.enabled(),
        language: readOcrSettings(ctx.cfg).language,
        state: ctx.ocrJob.enabled() ? ctx.ocrJob.state : "off",
        pending: ctx.ocrJob.pendingCount(),
        error: ctx.ocrJob.error,
      },
      libraryDir: ctx.cfg.libraryDir,
    };
  });

  registerLibraryRoutes(app);
  registerLookupRoutes(app);
  registerSearchRoutes(app);
  registerKnowledgeRoutes(app, opts.provider);

  if (opts.serveWeb) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = join(here, "..", "web-dist");
    if (existsSync(dist)) {
      await app.register(fastifyStatic, { root: dist });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
        return reply.type("text/html").send(createReadStream(join(dist, "index.html")));
      });
    }
  }
  return app;
}
