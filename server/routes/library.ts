import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../context.ts";
import { importFile, reprocessDocument, UnsupportedFileError } from "../ingest/pipeline.ts";
import {
  deleteDocument,
  getDocument,
  getPages,
  listDocuments,
  patchDocument,
} from "../library.ts";
import type { CollectionDto, ReadingStatus } from "../../shared/types.ts";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

export function registerLibraryRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/api/documents", async () => listDocuments(ctx));

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
    const doc = getDocument(ctx, Number(req.params.id));
    if (!doc) return reply.status(404).send({ error: "Document not found" });
    return doc;
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/pages", async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDocument(ctx, id)) return reply.status(404).send({ error: "Document not found" });
    return getPages(ctx, id);
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/file", async (req, reply) => {
    const row = ctx.db.prepare("SELECT stored_name, kind, original_name FROM documents WHERE id = ?").get(Number(req.params.id)) as
      | { stored_name: string; kind: string; original_name: string }
      | undefined;
    if (!row) return reply.status(404).send({ error: "Document not found" });
    const file = join(ctx.cfg.originalsDir, row.stored_name);
    if (!existsSync(file)) return reply.status(404).send({ error: "File missing from library folder" });
    reply.header("Content-Type", MIME[row.kind] ?? "application/octet-stream");
    reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(row.original_name)}"`);
    return reply.send(createReadStream(file));
  });

  app.post("/api/documents", async (req, reply) => {
    if (!req.isMultipart()) return reply.status(400).send({ error: "Send files as multipart/form-data" });
    const results: { name: string; document?: ReturnType<typeof getDocument>; duplicate?: boolean; error?: string }[] = [];
    for await (const part of req.files()) {
      const data = await part.toBuffer();
      try {
        const r = importFile(ctx, { name: part.filename, data });
        results.push({ name: part.filename, document: r.document, duplicate: r.duplicate });
      } catch (e) {
        if (e instanceof UnsupportedFileError) results.push({ name: part.filename, error: e.message });
        else throw e;
      }
    }
    return results;
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; author?: string | null; year?: number | null; readingStatus?: ReadingStatus };
  }>("/api/documents/:id", async (req, reply) => {
    try {
      const doc = patchDocument(ctx, Number(req.params.id), req.body ?? {});
      if (!doc) return reply.status(404).send({ error: "Document not found" });
      return doc;
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>("/api/documents/:id", async (req, reply) => {
    const res = deleteDocument(ctx, Number(req.params.id), req.query.force === "1");
    if (res.ok) return { ok: true };
    if (res.unitCount > 0) {
      return reply.status(409).send({
        error: `This document has ${res.unitCount} saved knowledge item${res.unitCount === 1 ? "" : "s"}. Deleting it removes them too.`,
        unitCount: res.unitCount,
      });
    }
    return reply.status(404).send({ error: "Document not found" });
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/reprocess", async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDocument(ctx, id)) return reply.status(404).send({ error: "Document not found" });
    await reprocessDocument(ctx, id);
    return getDocument(ctx, id);
  });

  // ---- collections: saved searches, shown as views (not folders) ----
  app.get("/api/collections", async (): Promise<CollectionDto[]> => {
    return ctx.db.prepare("SELECT id, name, query FROM collections ORDER BY name").all() as CollectionDto[];
  });

  app.post<{ Body: { name?: string; query?: string } }>("/api/collections", async (req, reply) => {
    const name = req.body?.name?.trim();
    const query = req.body?.query?.trim();
    if (!name || !query) return reply.status(400).send({ error: "name and query are required" });
    const info = ctx.db
      .prepare("INSERT INTO collections(name, query, created_at) VALUES (?,?,?)")
      .run(name, query, new Date().toISOString());
    return { id: Number(info.lastInsertRowid), name, query } satisfies CollectionDto;
  });

  app.delete<{ Params: { id: string } }>("/api/collections/:id", async (req) => {
    ctx.db.prepare("DELETE FROM collections WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });
}
