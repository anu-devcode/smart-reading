import type { Ctx } from "../context.ts";
import type { Candidate, DistillResponse } from "../../shared/types.ts";
import { readAiSettings, type AiSettings } from "../config.ts";
import { compactOf, findSpan } from "../text/anchor.ts";
import { HttpError } from "../errors.ts";
import { paragraphAround, resolveSpan, type SelectionInput } from "./highlights.ts";

// AI proposes, the source grounds, the user decides.
// Nothing here writes to the library: it only returns candidates for the user to accept, edit or dismiss.

export interface RawCandidate {
  type?: unknown;
  text?: unknown;
  supportingQuote?: unknown;
}

export interface DistillInput {
  selection: string;
  paragraph: string;
  docTitle: string;
}

export interface DistillProvider {
  distill(input: DistillInput): Promise<RawCandidate[]>;
}

const SYSTEM_PROMPT = `You help a reader decide what is worth keeping from a passage they are reading.
Propose at most 3 candidates. Each candidate has a type:
- "idea": a proposition or takeaway stated in plain words.
- "concept": something to understand and recognise elsewhere. State what it MEANS, not just its name.
- "question": a genuine unresolved question that the passage raises.
Rules:
- Write each candidate in the same language as the passage.
- Stay within what the passage supports. Do not add outside facts.
- Every candidate MUST include "supportingQuote": a short span copied EXACTLY, character for character, from the PASSAGE.
- Reply with JSON only, in this shape: {"candidates":[{"type":"idea","text":"...","supportingQuote":"..."}]}`;

export class OpenAiCompatibleProvider implements DistillProvider {
  constructor(private s: AiSettings) {}

  async distill(input: DistillInput): Promise<RawCandidate[]> {
    const url = `${this.s.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const user = `Document: ${input.docTitle}\n\nThe reader selected:\n"""${input.selection}"""\n\nPASSAGE (the paragraph around the selection):\n"""${input.paragraph}"""`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.s.apiKey ? { Authorization: `Bearer ${this.s.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.s.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`AI provider returned ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    return parseCandidates(content);
  }
}

/** Extract {"candidates":[...]} from a model reply, tolerating code fences and surrounding prose. */
export function parseCandidates(content: string): RawCandidate[] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(content.slice(start, end + 1)) as { candidates?: unknown };
    return Array.isArray(obj.candidates) ? (obj.candidates as RawCandidate[]) : [];
  } catch {
    return [];
  }
}

const MIN_QUOTE_CHARS = 8;
const MAX_CANDIDATES = 3;

/**
 * Enforce provenance: a candidate survives only if its supporting quote appears verbatim
 * (ignoring whitespace and quote style) in the source paragraph. The quote is replaced with the
 * paragraph's own text, so what the user sees as "evidence" is always the real source wording.
 */
export function verifyCandidates(raw: RawCandidate[], paragraph: string): { candidates: Candidate[]; dropped: number } {
  const paraCompact = compactOf(paragraph);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let dropped = 0;
  for (const r of raw) {
    const type = r.type;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const quote = typeof r.supportingQuote === "string" ? r.supportingQuote : "";
    const valid =
      (type === "idea" || type === "concept" || type === "question") &&
      text.length > 0 &&
      text.length <= 600 &&
      compactOf(quote).length >= MIN_QUOTE_CHARS &&
      paraCompact.includes(compactOf(quote));
    if (!valid || seen.has(text.toLowerCase()) || out.length >= MAX_CANDIDATES) {
      dropped++;
      continue;
    }
    const span = findSpan(paragraph, quote);
    if (!span) {
      dropped++;
      continue;
    }
    seen.add(text.toLowerCase());
    out.push({ type: type as Candidate["type"], text, supportingQuote: span.text });
  }
  return { candidates: out, dropped };
}

export async function distillSelection(
  ctx: Ctx,
  provider: DistillProvider | null,
  input: SelectionInput,
): Promise<DistillResponse> {
  if (!provider) {
    throw new HttpError(400, "No AI provider is configured. Add one in Settings to use Distill. Everything else works without it.");
  }
  const span = resolveSpan(ctx, input);
  const paragraph = paragraphAround(ctx, input.docId, span).text;
  const doc = ctx.db.prepare("SELECT title FROM documents WHERE id = ?").get(input.docId) as { title: string };

  let raw: RawCandidate[];
  try {
    raw = await provider.distill({ selection: span.text, paragraph, docTitle: doc.title });
  } catch (e) {
    throw new HttpError(502, `The AI provider failed: ${(e as Error).message}`);
  }
  const { candidates, dropped } = verifyCandidates(raw, paragraph);
  return { candidates, dropped, anchor: { page: span.page, endPage: span.endPage, start: span.start, end: span.end, text: span.text } };
}

export function providerFromSettings(ctx: Ctx): DistillProvider | null {
  const s = readAiSettings(ctx.cfg);
  if (!s.baseUrl || !s.model) return null;
  return new OpenAiCompatibleProvider(s);
}
