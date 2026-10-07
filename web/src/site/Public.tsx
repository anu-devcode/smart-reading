import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandLockup } from "../brand";
import { href } from "../router";
import "./site.css";

export const PUBLIC_PAGES = ["home", "how-it-works", "features", "about", "faq", "contact", "privacy", "terms", "security", "signin"];

/** Adds `.in` to every `.reveal` inside the container once it scrolls into view. */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = root.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
  return ref;
}

const NAV: [string, string][] = [
  ["how-it-works", "How it works"],
  ["features", "Features"],
  ["about", "About"],
  ["faq", "FAQ"],
];

export function PublicLayout({ page, signedIn, children }: { page: string; signedIn: boolean; children: ReactNode }) {
  const ref = useReveal();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    ref.current?.scrollTo?.({ top: 0 });
  }, [page]);
  return (
    <div className="site" ref={ref}>
      <a className="skip" href="#site-main">
        Skip to content
      </a>
      <header className="site-head">
        <a className="site-brand" href={href(signedIn ? "home" : "")} aria-label="Anbabi, home">
          <BrandLockup />
        </a>
        <button className="site-menu" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>
          Menu
        </button>
        <nav id="site-nav" className={open ? "open" : ""} aria-label="Main">
          {NAV.map(([p, label]) => (
            <a key={p} href={href(p)} aria-current={page === p ? "page" : undefined}>
              {label}
            </a>
          ))}
          {signedIn ? (
            <a className="site-cta" href={href("")}>
              Open your library
            </a>
          ) : (
            <>
              <a href={href("signin")} aria-current={page === "signin" ? "page" : undefined}>
                Sign in
              </a>
              <a className="site-cta" href={href("signin")}>
                Get started
              </a>
            </>
          )}
        </nav>
      </header>
      <main id="site-main">{children}</main>
      <footer className="site-foot">
        <div className="foot-brand">
          <BrandLockup />
          <p className="muted">Read deeply. Keep what matters. Find it again.</p>
        </div>
        <nav aria-label="Product">
          <h4>Product</h4>
          <a href={href("how-it-works")}>How it works</a>
          <a href={href("features")}>Features</a>
          <a href={href("faq")}>FAQ</a>
        </nav>
        <nav aria-label="Company">
          <h4>About</h4>
          <a href={href("about")}>About</a>
          <a href={href("contact")}>Contact</a>
        </nav>
        <nav aria-label="Trust">
          <h4>Trust</h4>
          <a href={href("privacy")}>Privacy</a>
          <a href={href("security")}>Security</a>
          <a href={href("terms")}>Terms</a>
        </nav>
      </footer>
    </div>
  );
}

function Cta({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="cta-row">
      <a className="btn-lg primary" href={href(signedIn ? "" : "signin")}>
        {signedIn ? "Open your library" : "Get started"}
      </a>
      <a className="btn-lg ghost" href={href("how-it-works")}>
        See how it works
      </a>
    </div>
  );
}

// ---------- the product, drawn: small HTML mockups instead of heavy images ----------

function FilesScene() {
  return (
    <div className="scene scene-files" aria-hidden="true">
      {[
        ["PDF", "The Attention Budget"],
        ["PDF", "Learning That Lasts"],
        ["MD", "Reading notes"],
        ["TXT", "Lecture 4"],
      ].map(([k, t], i) => (
        <div key={t} className={`file f${i}`}>
          <span className="file-kind">{k}</span>
          <span className="file-lines" />
          <span className="file-title">{t}</span>
        </div>
      ))}
      <div className="tray">Drop files here</div>
    </div>
  );
}

function LibraryScene() {
  return (
    <div className="scene scene-library" aria-hidden="true">
      {[
        ["The Attention Budget", "Reading", "2 kept"],
        ["Learning That Lasts", "Unread", "Ready"],
        ["Reading notes", "To revisit", "5 kept"],
        ["Field Notes (scanned)", "Unread", "Ready"],
      ].map(([t, s, n]) => (
        <div className="shelf-row" key={t}>
          <span className="spine" />
          <span className="shelf-title">{t}</span>
          <span className="pill">{s}</span>
          <span className="pill soft">{n}</span>
        </div>
      ))}
    </div>
  );
}

function ReadScene() {
  return (
    <div className="scene scene-read" aria-hidden="true">
      <div className="paper">
        <span className="pg">p. 2</span>
        <p>
          Every notification, meeting and open tab draws on the same limited supply. <mark className="sweep">Attention is a scarce resource, and what is spent on one thing cannot be spent on another.</mark> Teams that guard it finish more of what they start.
        </p>
        <div className="selbar-mock">
          <span>Highlight</span>
          <span className="on">Keep as Quote</span>
          <span>Write idea…</span>
        </div>
      </div>
    </div>
  );
}

function KeepScene() {
  return (
    <div className="scene scene-keep" aria-hidden="true">
      <div className="kept k1">
        <span className="badge type-quote">Quote</span>
        <p>“Attention is a scarce resource…”</p>
        <span className="src">The Attention Budget · p. 2</span>
      </div>
      <div className="kept k2">
        <span className="badge type-idea">Idea</span>
        <p>Attention is a fixed budget: whatever one thing takes, another loses.</p>
        <span className="src">The Attention Budget · p. 2</span>
      </div>
      <div className="kept k3">
        <span className="badge type-question">Question</span>
        <p>What would our week look like with one meeting-free day?</p>
        <span className="src">The Attention Budget · p. 3</span>
      </div>
    </div>
  );
}

function FindScene() {
  return (
    <div className="scene scene-find" aria-hidden="true">
      <div className="searchbox">
        <span className="q">attention scarce</span>
        <span className="caret" />
      </div>
      <div className="result">
        <span className="badge type-quote">Quote</span>
        <p>
          <mark>Attention</mark> is a <mark>scarce</mark> resource…
        </p>
        <span className="src">Why it matched: your words · The Attention Budget, p. 2</span>
      </div>
      <div className="result r2">
        <span className="badge type-idea">Idea</span>
        <p>A fixed budget: whatever one thing takes, another loses.</p>
        <span className="src">Why it matched: similar meaning · p. 2</span>
      </div>
    </div>
  );
}

function ReuseScene() {
  return (
    <div className="scene scene-reuse" aria-hidden="true">
      <div className="doc-draft">
        <span className="line w80" />
        <span className="line w60" />
        <blockquote>
          “Attention is a scarce resource, and what is spent on one thing cannot be spent on another.”
          <cite>— Fixture Author, The Attention Budget, p. 2</cite>
        </blockquote>
        <span className="line w70" />
        <span className="line w40" />
      </div>
      <span className="copied">Copied with its source</span>
    </div>
  );
}

const STORY = [
  { n: "01", title: "Bring in what you read", body: "Drop in PDFs, Markdown or plain text. Even scanned pages become searchable. Nothing is written or summarised for you — your files are simply read and indexed.", Scene: FilesScene },
  { n: "02", title: "A library that organises itself", body: "No folders to choose. Every document is ready to read, with where you are in it: unread, reading, or to revisit.", Scene: LibraryScene },
  { n: "03", title: "Read, and select what matters", body: "Open any document in a calm reader. Select a sentence — or a passage across pages — and decide what it is to you.", Scene: ReadScene },
  { n: "04", title: "Keep it, tied to its page", body: "Save it as a quote, an idea in your own words, a concept or a question. Each one points back to the exact words and page it came from.", Scene: KeepScene },
  { n: "05", title: "Find it again, months later", body: "Search the way you remember things — exact words, or just the gist. Your saved knowledge comes first, and every result tells you why it matched.", Scene: FindScene },
  { n: "06", title: "Use it with confidence", body: "Copy any note with its citation, open the source in one click, or export everything. Your knowledge stays checkable.", Scene: ReuseScene },
];

/** Scroll-told story: the steps scroll by while one picture changes beside them. */
function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <section className="story" aria-labelledby="story-title">
      <div className="section-head reveal">
        <p className="eyebrow">How it works</p>
        <h2 id="story-title">From a pile of files to knowledge you can trust.</h2>
      </div>
      <div className="story-grid">
        <ol className="story-steps">
          {STORY.map((s, i) => (
            <li key={s.n} data-i={i} ref={(el) => void (refs.current[i] = el)} className={i === active ? "active" : ""}>
              <span className="step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <div className="step-visual-inline">
                <s.Scene />
              </div>
            </li>
          ))}
        </ol>
        <div className="story-stage" aria-hidden="true">
          <div className="stage-frame">
            {STORY.map((s, i) => (
              <div key={s.n} className={`stage-slide ${i === active ? "on" : ""}`}>
                <s.Scene />
              </div>
            ))}
            <div className="stage-progress">
              {STORY.map((s, i) => (
                <span key={s.n} className={i <= active ? "done" : ""} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hv-page">
        <span className="pg">p. 2</span>
        <span className="line w90" />
        <span className="line w75" />
        <p className="hv-text">
          <mark className="sweep">Attention is a scarce resource.</mark>
        </p>
        <span className="line w85" />
        <span className="line w60" />
        <span className="line w80" />
        <span className="line w45" />
      </div>
      <div className="hv-card">
        <span className="badge type-quote">Quote</span>
        <p>“Attention is a scarce resource.”</p>
        <span className="src">The Attention Budget · p. 2</span>
      </div>
      <div className="hv-search">
        <span>⌕</span> what did I read about attention?
      </div>
    </div>
  );
}

// ---------- pages ----------

export function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow reveal in">A reading companion that remembers</p>
          <h1 className="reveal in">
            Read deeply. <em>Keep what matters.</em> Find it again.
          </h1>
          <p className="lede reveal in">
            Anbabi is a calm home for the PDFs and notes you read. Highlight a sentence, keep it as a quote or an idea, and it stays tied to the exact page it came from — so years later you can find it, trust it and use it.
          </p>
          <div className="reveal in">
            <Cta signedIn={signedIn} />
          </div>
        </div>
        <HeroVisual />
      </section>

      <section className="flow-strip reveal" aria-label="The five steps">
        {["Import", "Read", "Keep what matters", "Find it later", "Reuse it"].map((s, i) => (
          <span key={s}>
            <b>{String(i + 1).padStart(2, "0")}</b> {s}
          </span>
        ))}
      </section>

      <Story />

      <section className="principles">
        <div className="section-head reveal">
          <p className="eyebrow">What we promise</p>
          <h2>Built on three simple rules.</h2>
        </div>
        <div className="three">
          {[
            ["Nothing is kept unless you keep it.", "Your library fills with what you choose, not with automatic summaries. Suggestions, if you ask for them, are only suggestions."],
            ["Every note points back to its page.", "A quote is the exact words from the source. An idea always carries the passage that inspired it. One click opens the page."],
            ["Your library is yours alone.", "Your files and notes stay on your own computer or server. Each person has a separate, private library."],
          ].map(([t, b], i) => (
            <article key={t} className="principle reveal" style={{ transitionDelay: `${i * 90}ms` }}>
              <span className="principle-n">{i + 1}</span>
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="audience">
        <div className="section-head reveal">
          <p className="eyebrow">Who it is for</p>
          <h2>For anyone who reads to learn.</h2>
        </div>
        <div className="four">
          {[
            ["Students", "Keep the lines your essay will need, with page numbers ready for the bibliography."],
            ["Researchers", "Connect findings that agree or disagree across papers, and always find the source again."],
            ["Professionals", "Turn reports and manuals into a searchable memory you can quote with confidence."],
            ["Curious readers", "Remember the ideas that changed your mind — not just that you once read them."],
          ].map(([t, b], i) => (
            <article key={t} className="who reveal" style={{ transitionDelay: `${i * 70}ms` }}>
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="closing reveal">
        <h2>Your reading, remembered.</h2>
        <p>Start with one document. Keep one sentence. Find it again next month.</p>
        <Cta signedIn={signedIn} />
      </section>
    </>
  );
}

function Article({ eyebrow, title, lede, children }: { eyebrow: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <article className="article">
      <header className="article-head reveal in">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </header>
      <div className="article-body">{children}</div>
    </article>
  );
}

export function HowItWorks({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <Article eyebrow="How it works" title="Five steps, the way you already read." lede="Anbabi does not ask you to learn a system. You read, you keep what matters, and it remembers where everything came from.">
        <span />
      </Article>
      <div className="how-list">
        {STORY.map((s, i) => (
          <section key={s.n} className={`how-row reveal ${i % 2 ? "flip" : ""}`}>
            <div className="how-copy">
              <span className="step-n">{s.n}</span>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </div>
            <div className="how-visual">
              <s.Scene />
            </div>
          </section>
        ))}
      </div>
      <section className="closing reveal">
        <h2>Ready when you are.</h2>
        <Cta signedIn={signedIn} />
      </section>
    </>
  );
}

const FEATURES: [string, string, string][] = [
  ["Import", "Everything you read, in one place", "PDFs, Markdown and plain text. Scanned pages are read too, and clearly marked, so even photocopies become searchable. If a page cannot be read reliably, you are told why — nothing is guessed."],
  ["Read", "A reader made for keeping", "Clean pages, a table of contents, find-in-document, and selections that can run across pages. Your highlights and notes appear right where you left them."],
  ["Keep", "Four kinds of knowledge", "Quotes are the exact words. Ideas are your own words. Concepts name things. Questions keep you curious. Each one is tied to its passage and page."],
  ["Connect", "Notes that talk to each other", "Mark that two notes are the same idea, that one supports another, or that they contradict. When you save something similar to an earlier note, you are told."],
  ["Find", "Search that explains itself", "Type exact words, a phrase in quotes, or describe an idea in your own words. Saved knowledge comes first, then passages, then documents — each with the reason it matched."],
  ["Suggest", "Optional help that never decides for you", "Ask for suggested ideas or questions from a passage you selected. Nothing is saved unless you accept it, and any suggestion that cannot point to the text is thrown away."],
  ["Reuse", "Copy with citation", "One click copies a quote or idea with author, title, year and page. Open the source to check it in context."],
  ["Own", "Export, back up, keep forever", "Download everything as a readable file, or back up your whole library. Your notes never depend on any outside service."],
];

export function Features({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <Article eyebrow="Features" title="Everything you need to read well. Nothing you don’t." lede="A small set of careful tools, each one designed around the same promise: what you keep stays true to its source.">
        <span />
      </Article>
      <div className="feature-grid">
        {FEATURES.map(([k, t, b], i) => (
          <article key={t} className="feature reveal" style={{ transitionDelay: `${(i % 2) * 80}ms` }}>
            <span className="eyebrow">{k}</span>
            <h3>{t}</h3>
            <p>{b}</p>
          </article>
        ))}
      </div>
      <section className="closing reveal">
        <h2>See it with your own reading.</h2>
        <Cta signedIn={signedIn} />
      </section>
    </>
  );
}

export function About() {
  return (
    <Article eyebrow="About" title="We read a lot. We forgot most of it." lede="Anbabi began with a simple frustration: we highlighted, we took notes, and months later we could not find them — or could not remember where they came from.">
      <h2>Why it exists</h2>
      <p>Most tools either keep everything, so nothing stands out, or rewrite your reading into summaries you never chose. We wanted the opposite: a place where only what you decide to keep becomes part of your knowledge, and where every note can be checked against its source.</p>
      <h2>What we believe</h2>
      <ul className="nice">
        <li><strong>Reading is the work.</strong> The app should help you notice and remember, not read for you.</li>
        <li><strong>Trust needs a source.</strong> A note without its page is a rumour. Every note here has one.</li>
        <li><strong>Your library belongs to you.</strong> It lives on your own computer or server, and you can take it with you at any time.</li>
        <li><strong>Simple beats clever.</strong> Few kinds of notes, few kinds of connections, no folders to maintain.</li>
      </ul>
      <h2>Who makes it</h2>
      <p>Anbabi is a small, independent project, built carefully and slowly. It is designed for people who read to learn: students, researchers, professionals and curious readers.</p>
    </Article>
  );
}

const FAQ: [string, string][] = [
  ["What kinds of files can I add?", "PDFs, Markdown (.md) and plain text (.txt). Scanned PDFs work too: their pages are read with text recognition and clearly marked."],
  ["Does it summarise or rewrite my documents?", "No. Nothing is generated when you add a file. You decide what to keep. If you want, you can ask for suggestions on a passage you selected — but nothing is saved unless you accept it."],
  ["What is the difference between a highlight and a quote?", "A highlight is a mark on the page, like a pen. A quote is something you keep: it joins your knowledge, shows up first in search, and can be copied with its citation."],
  ["Can I find something if I don’t remember the exact words?", "Yes. Describe the idea in your own words and Anbabi looks for passages and notes with a similar meaning. Each result tells you whether it matched your words or your meaning."],
  ["Can other people see my library?", "No. Every account has its own separate library. The person who runs the server can add or remove accounts, but the app never shows one person’s documents or notes to another."],
  ["Where is my data stored?", "On the computer or server where Anbabi runs — not on ours. You can export everything to a readable file or make a full backup at any time."],
  ["Do I need an internet connection?", "Not for reading, keeping or searching. The optional suggestions use a service you choose, which may be online or on your own computer."],
  ["Can I use it on my phone or tablet?", "Anbabi works in the browser. If the person who runs it makes it reachable from other devices, you can sign in from a phone, tablet or another computer and find the same library."],
];

export function Faq() {
  return (
    <Article eyebrow="FAQ" title="Questions, answered plainly.">
      <div className="faq">
        {FAQ.map(([q, a]) => (
          <details key={q} className="reveal">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <p className="muted">
        Still wondering? <a href={href("contact")}>Get in touch</a>.
      </p>
    </Article>
  );
}

export function Contact() {
  return (
    <Article eyebrow="Contact" title="We’d like to hear from you." lede="Anbabi runs on your own computer or on a server run by someone you know, so help usually starts close to home.">
      <div className="two">
        <section className="panel-soft">
          <h3>Help with your account</h3>
          <p>Forgotten password, a new account, or a library that needs restoring: ask the person who runs your Anbabi server. They can set a new password for you from Settings.</p>
        </section>
        <section className="panel-soft">
          <h3>Running your own server</h3>
          <p>Setup, backups and moving to a new computer are covered step by step in the guide that comes with Anbabi (the README file).</p>
        </section>
      </div>
      <h2>Ideas and feedback</h2>
      <p>If something felt confusing, or you wish Anbabi did one thing differently, tell the person who shared it with you. Small, specific notes — “I expected this button to…” — help the most.</p>
    </Article>
  );
}

export function Privacy() {
  return (
    <Article eyebrow="Privacy" title="Privacy, in plain words." lede="Short version: your reading stays with you. There is no tracking, no advertising and no account with us.">
      <h2>What is stored, and where</h2>
      <p>Your documents, highlights, notes and settings are stored on the computer or server where Anbabi runs. Each account has its own separate library. Your password is never stored — only a secure fingerprint of it.</p>
      <h2>What leaves your library</h2>
      <ul className="nice">
        <li><strong>Nothing, by default.</strong> Reading, keeping, searching and reading scanned pages all happen where Anbabi runs.</li>
        <li><strong>Optional suggestions.</strong> Only if you set up a suggestion service and press the button, the passage you selected is sent to the service you chose. You can use one that runs on your own computer.</li>
        <li><strong>One-time downloads.</strong> The first time they are needed, the language files for search and scanned pages are downloaded. No reading data is sent.</li>
      </ul>
      <h2>What we count</h2>
      <p>Inside your own library, Anbabi quietly notes whether suggestions were accepted, edited or dismissed, to judge if they are useful. This stays in your library and is never sent anywhere.</p>
      <h2>Your control</h2>
      <p>You can export everything at any time, delete any document or note, and ask the server owner to remove your account — which deletes your whole library.</p>
    </Article>
  );
}

export function Terms() {
  return (
    <Article eyebrow="Terms" title="Terms of use." lede="Simple terms for a simple tool. If you run an Anbabi server for others, these describe what everyone can expect.">
      <h2>Your content</h2>
      <p>Everything you add and write remains yours. Anbabi only stores and indexes it so that you can read, keep and find it. Please only add documents you have the right to use.</p>
      <h2>Accounts</h2>
      <p>The person who runs the server creates accounts and is responsible for keeping the server and its backups safe. Keep your password to yourself; you are responsible for what is done with your account.</p>
      <h2>Suggestions</h2>
      <p>Optional suggestions come from a service you choose and may be wrong. They are never saved unless you accept them. Always check important quotes against the source — one click opens it.</p>
      <h2>No warranty</h2>
      <p>Anbabi is provided as it is. We work hard to keep your notes accurate and safe, but please keep regular backups of anything that matters to you.</p>
      <h2>Changes</h2>
      <p>If these terms change, the new version will be shown here.</p>
    </Article>
  );
}

export function Security() {
  return (
    <Article eyebrow="Security" title="How your library is protected." lede="Security here means two things: nobody else can read your library, and nothing you keep is ever quietly changed.">
      <div className="two">
        <section className="panel-soft">
          <h3>Separate libraries</h3>
          <p>Every account has its own library, stored apart from everyone else’s. There is no shared list of documents that could be shown to the wrong person.</p>
        </section>
        <section className="panel-soft">
          <h3>Careful sign-in</h3>
          <p>Passwords are stored only as secure fingerprints. Repeated wrong passwords slow down further tries. Changing your password signs you out on other devices.</p>
        </section>
        <section className="panel-soft">
          <h3>Protected sessions</h3>
          <p>Your sign-in cannot be read by scripts on web pages, and changes sent from other websites are refused.</p>
        </section>
        <section className="panel-soft">
          <h3>Truthful notes</h3>
          <p>A quote is always the exact text from the page. If a document changes and a note can no longer be found, it is marked — never silently moved.</p>
        </section>
      </div>
      <h2>For the person running the server</h2>
      <p>By default Anbabi only answers on the computer it runs on. If you open it to other devices, put a secure (HTTPS) connection in front of it, and keep regular backups. The guide that comes with Anbabi explains both.</p>
    </Article>
  );
}

export function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <section className="signin-wrap">
      <div className="signin-aside reveal in" aria-hidden="true">
        <blockquote>
          “Attention is a scarce resource, and what is spent on one thing cannot be spent on another.”
          <cite>The Attention Budget · p. 2</cite>
        </blockquote>
        <p>Everything you keep, exactly where you left it.</p>
      </div>
      <div className="signin-main">{children}</div>
    </section>
  );
}

export function PublicPage({ page, signedIn, signIn }: { page: string; signedIn: boolean; signIn: ReactNode }) {
  let body: ReactNode;
  if (page === "how-it-works") body = <HowItWorks signedIn={signedIn} />;
  else if (page === "features") body = <Features signedIn={signedIn} />;
  else if (page === "about") body = <About />;
  else if (page === "faq") body = <Faq />;
  else if (page === "contact") body = <Contact />;
  else if (page === "privacy") body = <Privacy />;
  else if (page === "terms") body = <Terms />;
  else if (page === "security") body = <Security />;
  else if (page === "signin") body = <SignInFrame>{signIn}</SignInFrame>;
  else body = <Landing signedIn={signedIn} />;
  return (
    <PublicLayout page={page} signedIn={signedIn}>
      <div key={page} className="page-fade">
        {body}
      </div>
    </PublicLayout>
  );
}
