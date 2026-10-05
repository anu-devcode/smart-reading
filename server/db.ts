import Database from "better-sqlite3";

export type DB = Database.Database;

const TOKENIZER = "tokenize='porter unicode61 remove_diacritics 2'";

const SCHEMA_V1 = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  year INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('pdf','text','markdown')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL UNIQUE,
  page_count INTEGER NOT NULL DEFAULT 0,
  processing_status TEXT NOT NULL DEFAULT 'processing'
    CHECK (processing_status IN ('processing','ready','partial','failed')),
  reading_status TEXT NOT NULL DEFAULT 'unread'
    CHECK (reading_status IN ('unread','reading','finished','revisit')),
  failure_notes TEXT NOT NULL DEFAULT '[]',
  added_at TEXT NOT NULL
);

CREATE TABLE pages (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','garbled')),
  PRIMARY KEY (doc_id, page)
);

CREATE TABLE passages (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX passages_doc_page ON passages(doc_id, page);

CREATE VIRTUAL TABLE passages_fts USING fts5(body, ${TOKENIZER});
CREATE VIRTUAL TABLE documents_fts USING fts5(title, author, ${TOKENIZER});
CREATE VIRTUAL TABLE units_fts USING fts5(content, note, ${TOKENIZER});

CREATE TABLE highlights (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  text TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  note TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX highlights_doc ON highlights(doc_id, page);

CREATE TABLE units (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('quote','idea','concept','question')),
  content TEXT NOT NULL,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  passage_id INTEGER,
  highlight_id INTEGER REFERENCES highlights(id) ON DELETE SET NULL,
  note TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','distill')),
  edited INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT NOT NULL
);
CREATE INDEX units_doc ON units(doc_id);

CREATE TABLE unit_links (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('same_idea','supports','contradicts')),
  created_at TEXT NOT NULL,
  UNIQUE (from_id, to_id, relation),
  CHECK (from_id <> to_id)
);

-- Recorded quietly. Not shown and not acted on in V1.
CREATE TABLE candidate_events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accept','edit','dismiss')),
  unit_type TEXT NOT NULL,
  doc_id INTEGER
);

-- Derived and rebuildable. Never user data.
CREATE TABLE embeddings (
  kind TEXT NOT NULL CHECK (kind IN ('passage','unit')),
  ref_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (kind, ref_id, model)
);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const MIGRATIONS: string[] = [SCHEMA_V1];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}
