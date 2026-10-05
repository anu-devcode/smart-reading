// Throwaway end-to-end check of Distill against the RUNNING server, using a fake OpenAI-compatible provider.
import { createServer } from "node:http";

const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    console.log("fake provider got:", req.url, "auth:", req.headers.authorization);
    const content = JSON.stringify({
      candidates: [
        { type: "idea", text: "Focus is a limited budget that every distraction draws down.", supportingQuote: "what is spent on one thing cannot be spent on another" },
        { type: "concept", text: "Invented thing", supportingQuote: "this sentence does not exist in the source" },
      ],
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

await new Promise<void>((r) => fake.listen(4999, "127.0.0.1", r));
const base = "http://127.0.0.1:4177";
const put = await fetch(base + "/api/settings", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ai: { baseUrl: "http://127.0.0.1:4999/v1", model: "fake", apiKey: "k" } }),
});
console.log("settings:", await put.json());

const docs = (await (await fetch(base + "/api/documents")).json()) as { id: number; title: string }[];
const doc = docs.find((d) => d.title === "The Attention Budget")!;
const d = await fetch(base + "/api/distill", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ docId: doc.id, page: 2, selectionText: "Attention is a scarce resource. Every notification, meeting, and open tab draws on the same limited supply, and what is spent on one thing cannot be spent on another." }),
});
const out = await d.json();
console.log("distill:", JSON.stringify(out, null, 1));
const before = await (await fetch(base + "/api/units")).json();
console.log("units unchanged by Distill (still only user-kept):", (before as unknown[]).length);

// restore: no AI configured
await fetch(base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ai: { baseUrl: "", model: "", apiKey: "" } }) });
fake.close();
