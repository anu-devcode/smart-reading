// Throwaway: a fake OpenAI-compatible provider that stays up, for clicking through the Distill UI.
import { createServer } from "node:http";

createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const content = JSON.stringify({
      candidates: [
        { type: "idea", text: "Focus is a limited budget that every distraction draws down.", supportingQuote: "what is spent on one thing cannot be spent on another" },
        { type: "question", text: "What deserves to be paid for with attention at all?", supportingQuote: "deserves to be paid for at all" },
        { type: "concept", text: "Invented thing", supportingQuote: "this sentence does not exist in the source" },
      ],
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(4999, "127.0.0.1", () => console.log("fake AI on 4999"));
