import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf } from "./pdfbuilder.ts";
import { PDF_FIXTURES, TEXT_FIXTURES } from "./fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "fixtures");

export function makeFixtures(dir: string = FIXTURE_DIR): string {
  mkdirSync(dir, { recursive: true });
  for (const f of PDF_FIXTURES) {
    writeFileSync(join(dir, f.file), buildPdf(f.pages, f.title, f.outline));
  }
  for (const t of TEXT_FIXTURES) {
    writeFileSync(join(dir, t.file), t.content, "utf8");
  }
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("fixtures written to", makeFixtures());
}
