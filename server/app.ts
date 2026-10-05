import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./context.ts";
import type { StatusDto } from "../shared/types.ts";
import { readAiSettings } from "./config.ts";
import { registerLibraryRoutes } from "./routes/library.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerLookupRoutes } from "./routes/library-extra.ts";
import { registerKnowledgeRoutes } from "./routes/knowledge.ts";
import type { DistillProvider } from "./knowledge/distill.ts";
import { HttpError } from "./errors.ts";

export interface AppOptions {
  /** override the AI provider (tests) */
  provider?: DistillProvider;
  serveWeb?: boolean;
}

export async function buildApp(ctx: Ctx, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 50 } });

  app.setErrorHandler((err: Error & { statusCode?: number; status?: number }, _req, reply) => {
    const code = err instanceof HttpError ? err.status : err.statusCode;
    const status = code && code >= 400 ? code : 500;
    reply.status(status).send({ error: err.message });
  });

  app.get("/api/status", async (): Promise<StatusDto> => {
    const ai = readAiSettings(ctx.cfg);
    return {
      embedding: {
        state: ctx.embedder ? ctx.embedJob.state : "off",
        model: ctx.cfg.embeddingModel,
        pending: ctx.embedJob.pendingCount(),
        error: ctx.embedJob.error,
      },
      ai: { configured: !!(ai.baseUrl && ai.model), model: ai.model || null },
      libraryDir: ctx.cfg.libraryDir,
    };
  });

  registerLibraryRoutes(app, ctx);
  registerLookupRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerKnowledgeRoutes(app, ctx, opts.provider);

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
