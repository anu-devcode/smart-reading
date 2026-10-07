import type { PageSpec } from "./pdfbuilder.ts";

export type FixtureDoc = {
  file: string;
  title: string;
  pages: PageSpec[];
  /** with no OCR available */
  expectStatus: "ready" | "partial" | "failed";
  /** with OCR switched on, when that changes the outcome */
  expectStatusWithOcr?: "ready" | "partial" | "failed";
  /** bookmarks (the PDF's own table of contents) */
  outline?: { title: string; page: number }[];
};

/** What the scanned fixtures show, so the acceptance run can check what OCR reads against it. */
export const SCANNED_TEXT: Record<string, string[][]> = {
  "scanned-memo.pdf": [
    [],
    [
      "The lighthouse keeper recorded the height of the tide every evening, because the harbour pilots relied on those tables when the fog came in.",
      "Fog signals were sounded whenever visibility dropped below half a mile, and the logbook shows that this happened on thirty nights in the winter of that year.",
    ],
  ],
  "scanned-notes.pdf": [
    [
      "A beekeeper learns early that a colony is not a collection of insects but a single organism. The queen, the workers and the drones each carry a task that the hive as a whole depends upon.",
    ],
    [
      "In late summer the beekeeper removes the honey supers and leaves enough stores for the winter. Taking too much is the most common mistake made by beginners.",
    ],
  ],
};

const P = (...paragraphs: string[]): PageSpec => ({ paragraphs });
const DRAWING: PageSpec = { drawingOnly: true };

export const PDF_FIXTURES: FixtureDoc[] = [
  {
    file: "attention-budget.pdf",
    title: "The Attention Budget",
    expectStatus: "ready",
    pages: [
      P(
        "Modern knowledge work is built from small interruptions. A message arrives, a calendar reminder fires, a colleague leans over a desk, and each of these events asks for a moment of notice before anyone has decided whether it deserves one.",
        "Designers of workflows rarely count the cost of these moments individually, because each one looks cheap. The cost appears only in aggregate, at the end of a day that felt busy but produced little finished work.",
      ),
      P(
        "Attention is a scarce resource. Every notification, meeting, and open tab draws on the same limited supply, and what is spent on one thing cannot be spent on another.",
        "Treating focus as a budget changes the question from how to fit more in toward what deserves to be paid for at all. A team that protects deep work hours is making an allocation decision, not a lifestyle choice.",
      ),
      P(
        "Context switching has a cost that outlasts the interruption itself. After returning to a task, a person needs time to rebuild the mental picture they had before they left, and during that time the quality of their thinking is lower.",
        "Batching similar tasks together reduces the number of rebuilds. Batching communication into fixed windows is the simplest policy that works.",
      ),
    ],
  },
  {
    file: "learning-that-lasts.pdf",
    title: "Learning That Lasts",
    expectStatus: "ready",
    outline: [
      { title: "The forgetting curve", page: 1 },
      { title: "Spaced repetition", page: 2 },
      { title: "Retrieval practice", page: 3 },
    ],
    pages: [
      P(
        "Memory fades on a predictable curve. Soon after first meeting a fact, most of it is lost, and the loss slows as time passes. The shape of this decline was first measured with lists of nonsense syllables and has been reproduced many times since.",
        "Understanding the curve explains why a single long study session feels productive and yet leaves so little behind a week later.",
      ),
      P(
        "Because forgetting is steady, reviewing material at growing intervals strengthens memory far more than cramming it all at once. This practice is called spaced repetition: study today, again tomorrow, then in three days, then in a week.",
        "Each successful recall resets the curve at a shallower slope, so the next review can wait longer. Cramming skips this mechanism entirely and relies on short-term holding.",
      ),
      P(
        "Retrieval practice means testing yourself instead of rereading. Pulling an answer out of memory is itself the thing that makes the memory durable, and the effort that feels uncomfortable is part of why it works.",
        "A simple routine is to close the book and write down everything remembered before checking.",
      ),
    ],
  },
  {
    file: "choices-and-trade-offs.pdf",
    title: "Choices and Trade-offs",
    expectStatus: "ready",
    pages: [
      P(
        "Every decision closes some doors. The opportunity cost of a choice is the value of the best alternative you gave up. It is rarely visible on a receipt, which is exactly why it is so often ignored.",
        "A hundred hours spent polishing a feature are a hundred hours not spent fixing the problem customers complain about most.",
      ),
      P(
        "The sunk cost fallacy is the habit of continuing because of what has already been spent. Past spending cannot be recovered by spending more, so it should not weigh on a decision about the future.",
        "A useful test is to ask whether you would start this project today, knowing what you now know.",
      ),
      P(
        "Decision fatigue describes the decline in judgement after many choices in a row. Reducing small decisions, through routines and defaults, saves capacity for the ones that matter.",
      ),
    ],
  },
  {
    file: "systems-and-complexity.pdf",
    title: "Systems and Complexity",
    expectStatus: "ready",
    pages: [
      P(
        "Software complexity grows faster than the number of components, because every new part can interact with every existing part. Ten modules have forty-five possible pairings; twenty modules have one hundred and ninety.",
        "This is why large programs become hard to change even when each piece is simple on its own.",
      ),
      P(
        "Modularity limits the damage. A boundary that hides internal detail reduces the number of interactions that have to be understood at the same time, which is the real purpose of an interface.",
        "Good boundaries follow the places where change is expected, not the places that look tidy on a diagram.",
      ),
      P(
        "Tests are a record of intended behaviour. They let a team change a system while keeping a precise memory of what must not change.",
      ),
    ],
  },
  {
    // Two-column layout, content stream written row by row. Page 1 has a full-width heading and a sentence
    // that runs from the bottom of the left column into the top of the right. Page 3 is a single-column control.
    file: "tide-pools.pdf",
    title: "Field Notes on Tide Pools",
    expectStatus: "ready",
    pages: [
      {
        heading: "Field Notes on Tide Pools",
        columns: [
          [
            "Tide pools form where rock basins hold seawater after the sea has gone out. The water warms, thins and salts up over a few hours, so every animal living there has to tolerate swings that would kill most sea creatures.",
            "Zonation is the first thing a visitor notices. The upper pools see sun and rain, the middle ones are wet most days, and the lowest are covered by every tide. Each band has its own residents, and the pools at the lowest edge are home to",
          ],
          [
            "anemones, hermit crabs and small fish that never leave. Barnacles close their shells to wait out the dry hours.",
            "Predators arrive with the tide. Sea stars pry open mussels slowly, with steady suction, and a single star can clear a whole rock face over a season. This pressure keeps the mussels from taking over.",
          ],
        ],
      },
      {
        columns: [
          [
            "Observation works best at the lowest tide of the month, when the outer pools are exposed for the longest stretch.",
            "Move slowly and keep your shadow off the water, because small animals retreat from sudden darkness.",
          ],
          [
            "Keep a notebook with the time, the tide height and the weather, so that visits can be compared across seasons.",
            "Return every rock to the position in which it was found, since the animals underneath depend on it for shade.",
          ],
        ],
      },
      P(
        "Summary",
        "Short notes.",
        "A reader who visits the same pools through the year learns more from the changes than from any single visit. The pattern of arrivals and departures is the real subject of the notes above.",
      ),
    ],
  },
  {
    // Page 2 has no extractable text (simulates a scanned page): expect PARTIAL.
    file: "partly-scanned.pdf",
    title: "Partly Scanned Report",
    expectStatus: "partial",
    pages: [
      P(
        "Quarterly summary. Revenue held steady while support volume rose, which the team attributes to the new onboarding flow.",
      ),
      DRAWING,
      P(
        "Appendix. The measurement method is described in the earlier report and has not changed.",
      ),
    ],
  },
  {
    // No extractable text at all: expect FAILED.
    file: "fully-scanned.pdf",
    title: "Fully Scanned Document",
    expectStatus: "failed",
    pages: [DRAWING, DRAWING],
  },
  {
    // A typed page and a scanned page (a picture of text): PARTIAL without OCR, READY once the scan is read.
    file: "scanned-memo.pdf",
    title: "Scanned Memo",
    expectStatus: "partial",
    expectStatusWithOcr: "ready",
    pages: [
      P("Field memo. This first page is typed and has a real text layer, so it never needs to be read as an image."),
      { scanned: SCANNED_TEXT["scanned-memo.pdf"][1] },
    ],
  },
  {
    // Every page is a picture of text: FAILED without OCR, READY once it is read.
    file: "scanned-notes.pdf",
    title: "Scanned Notes",
    expectStatus: "failed",
    expectStatusWithOcr: "ready",
    pages: SCANNED_TEXT["scanned-notes.pdf"].map((paras) => ({ scanned: paras })),
  },
];

export const TEXT_FIXTURES: { file: string; content: string }[] = [
  {
    file: "reading-notes.md",
    content: `# Reading Notes on Habits

## Cues and routines

A habit forms when a cue reliably triggers a routine and the routine is followed by a reward. Changing the cue is easier than fighting the urge directly.

## Friction

Reducing friction for the behaviour you want and adding friction for the one you do not is the cheapest intervention available.
`,
  },
];

export type EvalQuery = {
  id: string;
  kind: "phrase" | "boolean" | "field" | "meaning";
  query: string;
  expectFile: string;
  expectPage?: number;
  /** For meaning queries: how deep in the ranking the expected passage may appear */
  topK: number;
};

export const EVAL_QUERIES: EvalQuery[] = [
  {
    id: "phrase-opportunity-cost",
    kind: "phrase",
    query: '"best alternative you gave up"',
    expectFile: "choices-and-trade-offs.pdf",
    expectPage: 1,
    topK: 1,
  },
  {
    id: "phrase-scarce-resource",
    kind: "phrase",
    query: '"attention is a scarce resource"',
    expectFile: "attention-budget.pdf",
    expectPage: 2,
    topK: 1,
  },
  {
    id: "boolean-forgetting-intervals",
    kind: "boolean",
    query: "forgetting AND intervals",
    expectFile: "learning-that-lasts.pdf",
    expectPage: 2,
    topK: 1,
  },
  {
    id: "column-sentence-continues",
    kind: "phrase",
    query: '"home to anemones"',
    expectFile: "tide-pools.pdf",
    expectPage: 1,
    topK: 1,
  },
  {
    id: "column-wrapped-lines",
    kind: "phrase",
    query: '"swings that would kill most sea creatures"',
    expectFile: "tide-pools.pdf",
    expectPage: 1,
    topK: 1,
  },
  {
    id: "column-right-wrapped",
    kind: "phrase",
    query: '"close their shells to wait out the dry hours"',
    expectFile: "tide-pools.pdf",
    expectPage: 1,
    topK: 1,
  },
  {
    id: "column-second-page",
    kind: "phrase",
    query: '"lowest tide of the month"',
    expectFile: "tide-pools.pdf",
    expectPage: 2,
    topK: 1,
  },
  {
    // these two pages are pictures: the words below only exist because OCR read them
    id: "ocr-phrase-memo",
    kind: "phrase",
    query: '"harbour pilots relied on those tables"',
    expectFile: "scanned-memo.pdf",
    expectPage: 2,
    topK: 1,
  },
  {
    id: "ocr-phrase-notes",
    kind: "phrase",
    query: '"removes the honey supers"',
    expectFile: "scanned-notes.pdf",
    expectPage: 2,
    topK: 1,
  },
  {
    id: "ocr-meaning-notes",
    kind: "meaning",
    query: "beginners often harvest too much honey and leave the bees short of food for winter",
    expectFile: "scanned-notes.pdf",
    expectPage: 2,
    topK: 3,
  },
  {
    id: "boolean-not",
    kind: "boolean",
    query: "memory NOT cramming",
    expectFile: "learning-that-lasts.pdf",
    expectPage: 1,
    topK: 3,
  },
  {
    id: "field-title",
    kind: "field",
    query: "title:complexity",
    expectFile: "systems-and-complexity.pdf",
    topK: 3,
  },
  {
    id: "stem-interrupt",
    kind: "phrase",
    query: "interruption",
    expectFile: "attention-budget.pdf",
    topK: 3,
  },
  {
    id: "meaning-focus-limited",
    kind: "meaning",
    query: "my focus is limited so every distraction takes something away from other work",
    expectFile: "attention-budget.pdf",
    expectPage: 2,
    topK: 3,
  },
  {
    id: "meaning-cramming",
    kind: "meaning",
    query: "studying with gaps between sessions works better than last minute cramming",
    expectFile: "learning-that-lasts.pdf",
    expectPage: 2,
    topK: 3,
  },
  {
    id: "meaning-complex-programs",
    kind: "meaning",
    query: "why do big programs get harder to modify as they grow",
    expectFile: "systems-and-complexity.pdf",
    expectPage: 1,
    topK: 3,
  },
];
