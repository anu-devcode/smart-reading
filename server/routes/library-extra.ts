import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.ts";
import { notFound } from "../errors.ts";

/** Small lookups the reader needs to jump to a search result. */
export function registerLookupRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get<{ Params: { id: string } }>("/api/passages/:id", async (req) => {
    const r = ctx.db
      .prepare("SELECT id, doc_id AS docId, page, start, end, text FROM passages WHERE id = ?")
      .get(Number(req.params.id));
    if (!r) throw notFound("Passage not found");
    return r;
  });
}
