import type { FastifyInstance } from "fastify";
import { search } from "../search/search.ts";

export function registerSearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    return search(req.ctx, q);
  });
}
