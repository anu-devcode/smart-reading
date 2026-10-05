import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.ts";
import { search } from "../search/search.ts";

export function registerSearchRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    return search(ctx, q);
  });
}
