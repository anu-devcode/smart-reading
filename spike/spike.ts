// Slice 0: feasibility spike. Throwaway. Answers: does this plan survive this machine?
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtures } from "../eval/make-fixtures.ts";

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check} :: ${detail}`);
};

async function checkSqlite() {
  try {
    const db = new Database(":memory:");
    const v = db.prepare("select sqlite_version() as v").get() as { v: string };
    db.exec(`create virtual table p using fts5(title, body, tokenize='porter unicode61')`);
    db.prepare("insert into p(title, body) values (?, ?)").run(
      "Attention",
      "Attention is a scarce resource. Interruptions are costly.",
    );
    db.prepare("insert into p(title, body) values (?, ?)").run("Other", "Nothing relevant here at all.");
    const stem = db.prepare("select title from p where p match ? order by bm25(p)").all("interruption");
    const phrase = db.prepare("select title from p where p match ?").all('"scarce resource"');
    const col = db.prepare("select title from p where p match ?").all("title:attention");
    const bool = db.prepare("select title from p where p match ?").all("scarce NOT nothing");
    const snip = db.prepare("select snippet(p, 1, '[', ']', '...', 8) s from p where p match ?").get("scarce") as {
      s: string;
    };
    const ok = stem.length === 1 && phrase.length === 1 && col.length === 1 && bool.length === 1;
    record("sqlite+fts5", ok, `sqlite ${v.v}; stem/phrase/column/boolean ok=${ok}; snippet="${snip.s}"`);
  } catch (e) {
    record("sqlite+fts5", false, String(e));
  }
}

async function checkPdf() {
  try {
    const dir = makeFixtures();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const f of ["attention-budget.pdf", "partly-scanned.pdf", "fully-scanned.pdf"]) {
      const data = new Uint8Array(readFileSync(join(dir, f)));
      const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
      const perPage: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const items = tc.items.filter((it: any) => "str" in it && it.str.trim().length) as any[];
        const sample = items[0] ? `y=${items[0].transform[5].toFixed(0)} "${items[0].str.slice(0, 24)}"` : "no text";
        perPage.push(`p${i}:${items.length} items (${sample})`);
      }
      record("pdfjs-extract:" + f, true, `${doc.numPages} pages; ${perPage.join(" | ")}`);
    }
  } catch (e) {
    record("pdfjs-extract", false, String(e));
  }
}

function cosine(a: Float32Array, b: Float32Array) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

async function checkEmbeddings(model: string, qPrefix: string, pPrefix: string) {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const t0 = Date.now();
    const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
    const loadMs = Date.now() - t0;
    const embed = async (texts: string[]) => {
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      const dim = out.dims[1];
      const data = out.data as Float32Array;
      return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
    };
    const passages = [
      pPrefix + "Attention is a scarce resource. Every notification and meeting draws on the same limited supply.",
      pPrefix + "Reviewing material at growing intervals strengthens memory far more than cramming.",
      pPrefix + "Modularity limits the damage by hiding internal detail behind an interface.",
    ];
    const q = qPrefix + "my focus is limited so every distraction takes something away from other work";
    const t1 = Date.now();
    const [qv, ...pv] = await embed([q, ...passages]);
    const embedMs = Date.now() - t1;
    const sims = pv.map((v) => cosine(qv, v));
    const best = sims.indexOf(Math.max(...sims));
    record(
      "embeddings:" + model,
      best === 0,
      `dim=${qv.length}; load ${loadMs}ms; embed 4 texts ${embedMs}ms; best=passage#${best} sims=${sims.map((s) => s.toFixed(3)).join(",")}`,
    );
  } catch (e) {
    record("embeddings:" + model, false, String(e).slice(0, 300));
  }
}

await checkSqlite();
await checkPdf();
await checkEmbeddings("Xenova/multilingual-e5-small", "query: ", "passage: ");
await checkEmbeddings("Xenova/all-MiniLM-L6-v2", "", "");
await checkEmbeddings("Xenova/paraphrase-multilingual-MiniLM-L12-v2", "", "");

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nSPIKE: ${failed.length} check(s) failed` : "\nSPIKE: all checks passed");
process.exit(failed.length ? 1 : 0);
