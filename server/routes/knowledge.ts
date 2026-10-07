import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.ts";
import type { Relation, SettingsDto, UnitType } from "../../shared/types.ts";
import { readAiSettings, readOcrSettings, writeAiSettings, writeOcrSettings } from "../config.ts";
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

/** A selection from the reader; endPage/endText are set when it crosses pages. */
interface SelectionBody {
  docId: number;
  page: number;
  selectionText: string;
  hint?: number;
  endPage?: number;
  endText?: string;
}

export function registerKnowledgeRoutes(app: FastifyInstance, providerOverride?: DistillProvider) {
  // ---- highlights ----
  app.get<{ Params: { id: string } }>("/api/documents/:id/highlights", async (req) =>
    listHighlights(req.ctx, Number(req.params.id)),
  );

  app.post<{
    Body: SelectionBody & { note?: string | null };
  }>("/api/highlights", async (req) => {
    const b = req.body;
    if (!b || !b.docId || !b.page || !b.selectionText) throw badRequest("docId, page and selectionText are required");
    return createHighlight(req.ctx, b);
  });

  app.patch<{ Params: { id: string }; Body: { note?: string | null } }>("/api/highlights/:id", async (req) =>
    updateHighlight(req.ctx, Number(req.params.id), req.body?.note ?? null),
  );

  app.delete<{ Params: { id: string } }>("/api/highlights/:id", async (req) => {
    deleteHighlight(req.ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- units ----
  app.get<{ Querystring: { type?: UnitType; docId?: string } }>("/api/units", async (req) =>
    listUnits(req.ctx, { type: req.query.type, docId: req.query.docId ? Number(req.query.docId) : undefined }),
  );

  app.get<{ Params: { id: string } }>("/api/units/:id", async (req) => getUnitContext(req.ctx, Number(req.params.id)));

  app.post<{
    Body: SelectionBody & {
      type: UnitType;
      content?: string;
      note?: string | null;
      origin?: "manual" | "distill";
      candidateAction?: "accept" | "edit";
    };
  }>("/api/units", async (req) => {
    const b = req.body;
    if (!b || !b.type || !b.docId || !b.page || !b.selectionText) {
      throw badRequest("type, docId, page and selectionText are required");
    }
    return createUnit(req.ctx, b);
  });

  app.patch<{ Params: { id: string }; Body: { content?: string; note?: string | null } }>(
    "/api/units/:id",
    async (req) => updateUnit(req.ctx, Number(req.params.id), req.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>("/api/units/:id", async (req) => {
    deleteUnit(req.ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- relations (user-made only) ----
  app.post<{ Body: { fromId: number; toId: number; relation: Relation } }>("/api/unit-links", async (req) => {
    const b = req.body;
    if (!b?.fromId || !b?.toId || !b?.relation) throw badRequest("fromId, toId and relation are required");
    return { id: createLink(req.ctx, b.fromId, b.toId, b.relation) };
  });

  app.delete<{ Params: { id: string } }>("/api/unit-links/:id", async (req) => {
    deleteLink(req.ctx, Number(req.params.id));
    return { ok: true };
  });

  // ---- distill: proposes only, never writes ----
  app.post<{ Body: SelectionBody }>(
    "/api/distill",
    async (req) => {
      const b = req.body;
      if (!b?.docId || !b?.page || !b?.selectionText) throw badRequest("docId, page and selectionText are required");
      return distillSelection(req.ctx, providerOverride ?? providerFromSettings(req.ctx), b);
    },
  );

  // Dismissals are counted quietly (accepts/edits are counted when the unit is created).
  app.post<{ Body: { unitType: string; docId?: number } }>("/api/candidate-events", async (req) => {
    recordCandidateEvent(req.ctx, "dismiss", req.body?.unitType ?? "unknown", req.body?.docId ?? null);
    return { ok: true };
  });

  // ---- settings ----
  const settingsDto = (ctx: Ctx): SettingsDto => {
    const ai = readAiSettings(ctx.cfg);
    return { ai: { baseUrl: ai.baseUrl, model: ai.model, apiKeySet: !!ai.apiKey }, ocr: readOcrSettings(ctx.cfg) };
  };
  app.get("/api/settings", async (req): Promise<SettingsDto> => settingsDto(req.ctx));

  app.put<{ Body: { ai?: { baseUrl?: string; model?: string; apiKey?: string }; ocr?: { enabled?: boolean; language?: string } } }>(
    "/api/settings",
    async (req) => {
      if (req.body?.ai) writeAiSettings(req.ctx.cfg, req.body.ai);
      if (req.body?.ocr) {
        try {
          writeOcrSettings(req.ctx.cfg, req.body.ocr);
        } catch (e) {
          throw badRequest((e as Error).message);
        }
        void req.ctx.ocrJob.retry(); // switching OCR on (or changing the language) picks up waiting pages
      }
      return settingsDto(req.ctx);
    },
  );

  // ---- export (portable, model-independent) ----
  app.get("/api/export.json", async (req) => buildExport(req.ctx));
  app.get("/api/export.md", async (req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return buildMarkdown(req.ctx);
  });
  app.post("/api/export", async (req) => exportToDir(req.ctx));
}
