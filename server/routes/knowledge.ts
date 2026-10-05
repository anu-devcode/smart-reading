import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.ts";
import type { Relation, SettingsDto, UnitType } from "../../shared/types.ts";
import { readAiSettings, writeAiSettings } from "../config.ts";
import { badRequest } from "../errors.ts";
import {
  createHighlight,
  deleteHighlight,
  listHighlights,
  updateHighlight,
} from "../knowledge/highlights.ts";
import {
  createLink,
  createUnit,
  deleteLink,
  deleteUnit,
  getUnitContext,
  listUnits,
  recordCandidateEvent,
  updateUnit,
} from "../knowledge/units.ts";
import { distillSelection, providerFromSettings, type DistillProvider } from "../knowledge/distill.ts";
import { exportToDir, buildExport, buildMarkdown } from "../knowledge/export.ts";

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: Ctx, providerOverride?: DistillProvider) {
  // ---- highlights ----
  app.get<{ Params: { id: string } }>("/api/documents/:id/highlights", async (req) =>
    listHighlights(ctx, Number(req.params.id)),
  );

  app.post<{
    Body: { docId: number; page: number; selectionText: string; hint?: number; note?: string | null };
  }>("/api/highlights", async (req) => {
    const b = req.body;
    if (!b || !b.docId || !b.page || !b.selectionText) throw badRequest("docId, page and selectionText are required");
    return createHighlight(ctx, b);
  });

  app.patch<{ Params: { id: string }; Body: { note?: string | null } }>("/api/highlights/:id", async (req) =>
    updateHighlight(ctx, Number(req.params.id), req.body?.note ?? null),
  );

  app.delete<{ Params: { id: string } }>("/api/highlights/:id", async (req) => {
    deleteHighlight(ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- units ----
  app.get<{ Querystring: { type?: UnitType; docId?: string } }>("/api/units", async (req) =>
    listUnits(ctx, { type: req.query.type, docId: req.query.docId ? Number(req.query.docId) : undefined }),
  );

  app.get<{ Params: { id: string } }>("/api/units/:id", async (req) => getUnitContext(ctx, Number(req.params.id)));

  app.post<{
    Body: {
      type: UnitType;
      content?: string;
      docId: number;
      page: number;
      selectionText: string;
      hint?: number;
      note?: string | null;
      origin?: "manual" | "distill";
      candidateAction?: "accept" | "edit";
    };
  }>("/api/units", async (req) => {
    const b = req.body;
    if (!b || !b.type || !b.docId || !b.page || !b.selectionText) {
      throw badRequest("type, docId, page and selectionText are required");
    }
    return createUnit(ctx, b);
  });

  app.patch<{ Params: { id: string }; Body: { content?: string; note?: string | null } }>(
    "/api/units/:id",
    async (req) => updateUnit(ctx, Number(req.params.id), req.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>("/api/units/:id", async (req) => {
    deleteUnit(ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- relations (user-made only) ----
  app.post<{ Body: { fromId: number; toId: number; relation: Relation } }>("/api/unit-links", async (req) => {
    const b = req.body;
    if (!b?.fromId || !b?.toId || !b?.relation) throw badRequest("fromId, toId and relation are required");
    return { id: createLink(ctx, b.fromId, b.toId, b.relation) };
  });

  app.delete<{ Params: { id: string } }>("/api/unit-links/:id", async (req) => {
    deleteLink(ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- distill: proposes only, never writes ----
  app.post<{ Body: { docId: number; page: number; selectionText: string; hint?: number } }>(
    "/api/distill",
    async (req) => {
      const b = req.body;
      if (!b?.docId || !b?.page || !b?.selectionText) throw badRequest("docId, page and selectionText are required");
      return distillSelection(ctx, providerOverride ?? providerFromSettings(ctx), b);
    },
  );

  // Dismissals are counted quietly (accepts/edits are counted when the unit is created).
  app.post<{ Body: { unitType: string; docId?: number } }>("/api/candidate-events", async (req) => {
    recordCandidateEvent(ctx, "dismiss", req.body?.unitType ?? "unknown", req.body?.docId ?? null);
    return { ok: true };
  });

  // ---- settings ----
  app.get("/api/settings", async (): Promise<SettingsDto> => {
    const ai = readAiSettings(ctx.cfg);
    return { ai: { baseUrl: ai.baseUrl, model: ai.model, apiKeySet: !!ai.apiKey } };
  });

  app.put<{ Body: { ai?: { baseUrl?: string; model?: string; apiKey?: string } } }>("/api/settings", async (req) => {
    writeAiSettings(ctx.cfg, req.body?.ai ?? {});
    const ai = readAiSettings(ctx.cfg);
    return { ai: { baseUrl: ai.baseUrl, model: ai.model, apiKeySet: !!ai.apiKey } } satisfies SettingsDto;
  });

  // ---- export (portable, model-independent) ----
  app.get("/api/export.json", async () => buildExport(ctx));
  app.get("/api/export.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return buildMarkdown(ctx);
  });
  app.post("/api/export", async () => exportToDir(ctx));
}
