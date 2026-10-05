/**
 * Migrations are numbered, ordered, and idempotent. Never edit an applied migration —
 * append a new one. `user_version` is the source of truth for the applied prefix.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_idx ON records (kind, updated_at DESC)`,
    ],
  },
  {
    version: 2,
    name: 'full_text',
    up: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
         id UNINDEXED, body, tokenize = 'porter unicode61'
       )`,
    ],
  },
  {
    version: 3,
    name: 'morphology',
    up: [
      // The projection of a corpus analysis. The append-only ledger stays the source of
      // truth; these tables exist so a query never has to re-run the engine.
      `CREATE TABLE IF NOT EXISTS tokens (
         id            TEXT PRIMARY KEY,
         form          TEXT NOT NULL,
         gloss         TEXT NOT NULL DEFAULT '',
         provenance    TEXT NOT NULL DEFAULT '',
         ok            INTEGER NOT NULL,
         reason        TEXT,
         feature_issue TEXT,
         score         REAL NOT NULL DEFAULT 0,
         ambiguous     INTEGER NOT NULL DEFAULT 0,
         gap_count     INTEGER NOT NULL DEFAULT 0,
         corpus_hash   TEXT NOT NULL DEFAULT ''
       )`,
      `CREATE TABLE IF NOT EXISTS morphemes (
         token_id  TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
         position  INTEGER NOT NULL,
         lexeme_id TEXT NOT NULL,
         morph     TEXT NOT NULL,
         type      TEXT NOT NULL,
         gloss     TEXT NOT NULL DEFAULT '',
         span_from INTEGER NOT NULL,
         span_to   INTEGER NOT NULL,
         weight    REAL NOT NULL DEFAULT 0,
         known     INTEGER NOT NULL DEFAULT 1,
         features  TEXT NOT NULL DEFAULT '{}',
         PRIMARY KEY (token_id, position)
       )`,
      `CREATE TABLE IF NOT EXISTS alternates (
         token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
         position INTEGER NOT NULL,
         morphs   TEXT NOT NULL,
         score    REAL NOT NULL,
         PRIMARY KEY (token_id, position)
       )`,
      `CREATE TABLE IF NOT EXISTS review_nodes (
         id              TEXT PRIMARY KEY,
         token_id        TEXT REFERENCES tokens(id) ON DELETE CASCADE,
         token           TEXT NOT NULL,
         kind            TEXT NOT NULL,
         detail          TEXT NOT NULL DEFAULT '',
         priority        INTEGER NOT NULL DEFAULT 0,
         effort_minutes  INTEGER NOT NULL DEFAULT 0,
         deadline        TEXT,
         required_skill  TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS assignments (
         node_id       TEXT PRIMARY KEY REFERENCES review_nodes(id) ON DELETE CASCADE,
         reviewer_id   TEXT NOT NULL,
         day           TEXT NOT NULL,
         start_minute  INTEGER NOT NULL,
         end_minute    INTEGER NOT NULL,
         minutes       INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS tokens_form_idx ON tokens (form)`,
      `CREATE INDEX IF NOT EXISTS tokens_provenance_idx ON tokens (provenance)`,
      `CREATE INDEX IF NOT EXISTS morphemes_lexeme_idx ON morphemes (lexeme_id)`,
      `CREATE INDEX IF NOT EXISTS review_nodes_kind_idx ON review_nodes (kind, priority DESC)`,
      `CREATE INDEX IF NOT EXISTS assignments_day_idx ON assignments (day, start_minute)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS tokens_fts USING fts5 (
         id UNINDEXED, form, gloss, provenance, tokenize = 'porter unicode61'
       )`,
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function pendingMigrations(current: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
